// paat-launcher: native Windows launcher for the PAAT dashboard.
//
// Replaces the previous launch-dashboard.ps1 + .lnk-via-powershell flow with
// a single .exe that:
//
//   1. Acquires a named mutex (so two double-clicks don't spawn two dashboards)
//   2. Probes http://127.0.0.1:7321/healthz to see if the server is already alive
//   3. If the server is dead AND there are orphan Chrome processes with our
//      profile, kills those orphans so we don't end up focusing a dead window
//   4. Starts the dashboard server in a hidden window (via the resolved
//      `paat` CLI binary on PATH, falling back to the baked path)
//   5. Polls /healthz until the server answers 200 (~10 s timeout)
//   6. Finds an existing Chrome/Edge/Brave window with --user-data-dir
//      matching our profile dir; if found, focuses it
//   7. Otherwise spawns a fresh Chrome --app= window pointed at the dashboard
//
// Single-instance + orphan-recovery logic mirrors the .ps1 from PR #9 (the
// "launcher self-heals when server is dead but orphan chrome remains" fix).
//
// Cross-compiles to a ~5 MB statically-linked Windows .exe. No Node runtime
// bundled (the launcher only ever shells out to the user's installed Node).

package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	dashboardURL    = "http://127.0.0.1:7321/"
	healthzURL      = "http://127.0.0.1:7321/healthz"
	mutexName       = "PortPilotDashboardLauncher_v1"
	healthzTimeout  = 1 * time.Second
	waitForServerMs = 10000
	waitForWindowMs = 8000
	pollIntervalMs  = 200
)

func main() {
	// Step 1: acquire mutex. If we can't get it within 10s, another launcher
	// is already running — let it do the work.
	mutex, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(mutexName))
	if err != nil {
		os.Exit(0)
	}
	defer windows.CloseHandle(mutex)

	event, err := windows.WaitForSingleObject(mutex, 10000)
	if err != nil || (event != windows.WAIT_OBJECT_0 && event != windows.WAIT_ABANDONED) {
		os.Exit(0)
	}
	defer windows.ReleaseMutex(mutex)

	profileDir := filepath.Join(userProfile(), ".portpilot", "dashboard-app-profile")

	// Step 2: probe healthz.
	serverAlive := testHealthz()

	// Step 3: if server is dead but orphan chrome windows exist, kill them
	// so we don't end up focusing a "site can't be reached" page.
	if !serverAlive {
		killOrphanChrome(profileDir)
		if startServer() {
			serverAlive = waitForHealthz()
		}
	}

	// Step 4: find or open the dashboard window.
	if pid, hwnd := findDashboardWindow(profileDir); pid != 0 {
		// Existing dashboard chrome — just focus it.
		focusWindow(hwnd)
		return
	}

	if !serverAlive {
		// Server failed to start; without it the chrome window would just
		// show ERR_CONNECTION_REFUSED. Bail rather than make it worse.
		fmt.Fprintln(os.Stderr, "paat-launcher: dashboard server did not start within timeout")
		os.Exit(2)
	}

	// Make sure the profile dir exists before Chrome tries to use it.
	_ = os.MkdirAll(profileDir, 0o755)

	if launchChromeAppWindow(profileDir) {
		// Wait for the new window's HWND to become observable so a rapid
		// second click finds it (we still hold the mutex until then).
		for i := 0; i < (waitForWindowMs / pollIntervalMs); i++ {
			if pid, hwnd := findDashboardWindow(profileDir); pid != 0 {
				focusWindow(hwnd)
				return
			}
			time.Sleep(pollIntervalMs * time.Millisecond)
		}
	}
}

// ---------------------------------------------------------------------------
// healthz probe
// ---------------------------------------------------------------------------

func testHealthz() bool {
	client := &http.Client{Timeout: healthzTimeout}
	resp, err := client.Get(healthzURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

func waitForHealthz() bool {
	for i := 0; i < (waitForServerMs / pollIntervalMs); i++ {
		if testHealthz() {
			return true
		}
		time.Sleep(pollIntervalMs * time.Millisecond)
	}
	return false
}

// ---------------------------------------------------------------------------
// server startup
// ---------------------------------------------------------------------------

func startServer() bool {
	bin, args, ok := resolvePaatCommand()
	if !ok {
		return false
	}
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS,
	}
	if err := cmd.Start(); err != nil {
		return false
	}
	// Release the child so it survives this launcher exit.
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
	return true
}

// resolvePaatCommand finds the paat CLI binary. Strategy:
//
//	1. Look for `paat`, `port-authority`, or `portpilot` on PATH.
//	2. If none on PATH, fall back to the baked npm-global location.
//
// Returns (binary, args, ok). ok=false means we couldn't find a way to
// invoke paat at all — caller should bail.
func resolvePaatCommand() (string, []string, bool) {
	for _, name := range []string{"paat", "port-authority", "portpilot"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, []string{"dashboard", "--port", "7321", "--no-open"}, true
		}
	}
	// Fall back to the npm-global install location (Windows default).
	appData := os.Getenv("APPDATA")
	if appData != "" {
		candidate := filepath.Join(
			appData, "npm", "node_modules",
			"port-authority-agent-terminal-mcp",
			"dist", "src", "cli", "index.js",
		)
		if _, err := os.Stat(candidate); err == nil {
			node, err := exec.LookPath("node")
			if err == nil {
				return node, []string{candidate, "dashboard", "--port", "7321", "--no-open"}, true
			}
		}
	}
	return "", nil, false
}

// ---------------------------------------------------------------------------
// Chrome process enumeration (orphan kill + window focus)
// ---------------------------------------------------------------------------

// chromeProc represents one chrome.exe / msedge.exe / brave.exe process whose
// command line contains our --user-data-dir.
type chromeProc struct {
	pid     uint32
	hwnd    windows.HWND
	exeName string
}

// listDashboardChromeProcs enumerates chromium-family processes whose command
// line contains the given profile dir (--user-data-dir=<profileDir>). Uses
// the WMI / CreateToolhelp32Snapshot path; on access-denied for command line
// we fall back to a CIM PowerShell call.
func listDashboardChromeProcs(profileDir string) []chromeProc {
	// We use PowerShell's Get-CimInstance Win32_Process because it gives us
	// CommandLine reliably, which Win32 ToolHelp doesn't expose. The cost
	// (~150 ms one-time) is acceptable for a launcher.
	psScript := fmt.Sprintf(
		`Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'" -ErrorAction SilentlyContinue | `+
			`Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=%s') } | `+
			`ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.Name) }`,
		strings.ReplaceAll(profileDir, "'", "''"),
	)
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psScript).Output()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var procs []chromeProc
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		var pid uint32
		_, err := fmt.Sscanf(parts[0], "%d", &pid)
		if err != nil || pid == 0 {
			continue
		}
		hwnd := mainWindowOfPid(pid)
		procs = append(procs, chromeProc{pid: pid, hwnd: hwnd, exeName: parts[1]})
	}
	return procs
}

func killOrphanChrome(profileDir string) {
	for _, p := range listDashboardChromeProcs(profileDir) {
		_ = exec.Command("taskkill.exe", "/F", "/PID", fmt.Sprintf("%d", p.pid)).Run()
	}
}

func findDashboardWindow(profileDir string) (uint32, windows.HWND) {
	procs := listDashboardChromeProcs(profileDir)
	// Prefer one with a non-zero MainWindowHandle (it actually has a UI).
	for _, p := range procs {
		if p.hwnd != 0 {
			return p.pid, p.hwnd
		}
	}
	// Fall back to any matching proc (chrome may be mid-startup).
	if len(procs) > 0 {
		return procs[0].pid, procs[0].hwnd
	}
	return 0, 0
}

// ---------------------------------------------------------------------------
// Win32: find main window of a PID + focus it
// ---------------------------------------------------------------------------

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procEnumWindows         = user32.NewProc("EnumWindows")
	procGetWindowThreadPid  = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procGetWindow           = user32.NewProc("GetWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procShowWindowAsync     = user32.NewProc("ShowWindowAsync")
)

const (
	swRestore = 9
	gwOwner   = 4
)

func mainWindowOfPid(pid uint32) windows.HWND {
	var found windows.HWND
	cb := syscall.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadPid.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&wpid)))
		if wpid != pid {
			return 1 // continue
		}
		// Must be visible AND have no owner (i.e. a top-level window, not a dialog).
		visible, _, _ := procIsWindowVisible.Call(uintptr(hwnd))
		if visible == 0 {
			return 1
		}
		owner, _, _ := procGetWindow.Call(uintptr(hwnd), uintptr(gwOwner))
		if owner != 0 {
			return 1
		}
		found = hwnd
		return 0 // stop
	})
	procEnumWindows.Call(cb, 0)
	return found
}

func focusWindow(hwnd windows.HWND) {
	if hwnd == 0 {
		return
	}
	procShowWindowAsync.Call(uintptr(hwnd), swRestore)
	procSetForegroundWindow.Call(uintptr(hwnd))
}

// ---------------------------------------------------------------------------
// Chrome --app= launch
// ---------------------------------------------------------------------------

func launchChromeAppWindow(profileDir string) bool {
	chromeBin := findChromiumBinary()
	if chromeBin == "" {
		// No chromium-family browser installed. Fall back to launching the
		// URL in the user's default browser. UX is worse (regular tab not
		// app window), but at least the user sees the dashboard.
		_ = exec.Command("cmd.exe", "/c", "start", "", dashboardURL).Run()
		return true
	}
	args := []string{
		"--app=" + dashboardURL,
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
	}
	cmd := exec.Command(chromeBin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: false,
	}
	if err := cmd.Start(); err != nil {
		return false
	}
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
	return true
}

func findChromiumBinary() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("LocalAppData"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func userProfile() string {
	if up := os.Getenv("USERPROFILE"); up != "" {
		return up
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "."
}
