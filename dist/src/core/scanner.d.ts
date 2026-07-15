/**
 * One observation of a TCP listener on the local machine.
 */
export interface PortObservation {
    port: number;
    pid?: number;
    command?: string;
    commandLine?: string;
    protocol?: "tcp" | "tcp6";
    source: "sonar" | "native";
    raw?: unknown;
}
export interface ScanOptions {
    preferSonar?: boolean;
    includeIpv6?: boolean;
    signal?: AbortSignal;
}
export interface ScanResult {
    observations: PortObservation[];
    source: "sonar" | "native" | "empty";
    errors: string[];
}
/**
 * Detect whether the user has Sonar installed and on PATH.
 * We probe `sonar --help` rather than `--version` because some builds report a
 * non-zero exit code for `--version`.
 */
export declare function hasSonar(): Promise<boolean>;
export declare function scanWithSonar(opts?: ScanOptions): Promise<PortObservation[]>;
/** Parse `ps -o pid= -o command=` output without invoking a shell. The command
 * column deliberately stays intact: browser profile flags are what make an
 * attachment safe, so truncating it would be worse than returning nothing. */
export declare function parseUnixPsOutput(stdout: string): Map<number, {
    command?: string;
    commandLine?: string;
}>;
export declare function scanNative(opts?: ScanOptions): Promise<PortObservation[]>;
/**
 * Run a port scan, preferring sonar when available and falling back to
 * platform-native tooling otherwise. Errors from one backend do not abort the
 * other — we always return the best observation set we could gather.
 */
export declare function scanPorts(opts?: ScanOptions): Promise<ScanResult>;
/**
 * True if any observation occupies the requested port.
 */
export declare function isPortInUse(observations: PortObservation[], port: number): boolean;
export declare function observationsForPort(observations: PortObservation[], port: number): PortObservation[];
