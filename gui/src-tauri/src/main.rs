// Prevents an additional console window from popping up on Windows for
// release builds; debug builds keep stdout/stderr for development logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    paat_dashboard_lib::run()
}
