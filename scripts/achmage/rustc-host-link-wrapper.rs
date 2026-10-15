// RUSTC_WRAPPER for build-rhwp-wasm.ps1. Build scripts and proc macros are linked for the Windows GNU host, and
// the GNU linker cannot open the non-ASCII paths rustc hands it (rustc canonicalizes its sysroot and crate paths,
// which undoes any ASCII drive alias). Host artifacts are therefore linked with rust-lld, as the Windows desktop
// build does. Cargo gives host artifacts no RUSTFLAGS when --target is set, so a wrapper is the only
// hook that reaches them: invocations without --target get HOP_HOST_RUSTC_ARGS (0x1f-separated) appended.
// The wasm32 target invocations pass through unchanged, so the WASM output is unaffected.
use std::env;
use std::process::{exit, Command};

fn main() {
    let mut args = env::args_os().skip(1);
    let rustc = args.next().expect("rustc path");
    let rest: Vec<_> = args.collect();
    let mut command = Command::new(rustc);
    command.args(&rest);
    // Long command lines (web-sys) reach rustc as `@argfile`, one argument per line; read them for the decision.
    let mut text = Vec::new();
    for arg in rest.iter().map(|a| a.to_string_lossy().into_owned()) {
        match arg.strip_prefix('@').map(std::fs::read_to_string) {
            Some(Ok(file)) => text.extend(file.lines().map(str::to_owned)),
            _ => text.push(arg),
        }
    }
    let targeted = text.iter().any(|a| a.starts_with("--target"));
    if let (false, Some(extra)) = (targeted, env::var("HOP_HOST_RUSTC_ARGS").ok()) {
        command.args(extra.split('\u{1f}').filter(|a| !a.is_empty()));
        // gcc passes `-e DllMainCRTStartup` for DLLs; rust-lld without gcc would default to the MSVC name.
        let dll = text.windows(2).any(|w| w[0] == "--crate-type" && matches!(w[1].as_str(), "proc-macro" | "dylib" | "cdylib"))
            || text.iter().any(|a| matches!(a.as_str(), "--crate-type=proc-macro" | "--crate-type=dylib" | "--crate-type=cdylib"));
        if dll {
            command.args(["-C", "link-arg=--entry=DllMainCRTStartup"]);
        }
    }
    let status = command.status().expect("run rustc");
    exit(status.code().unwrap_or(1));
}
