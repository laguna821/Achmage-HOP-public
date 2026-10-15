// Native development builds are also user-facing: a console window must not
// own the editor lifetime. Diagnostics remain available through the app log.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    hop_desktop::run();
}
