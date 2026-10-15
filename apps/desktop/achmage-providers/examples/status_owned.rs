//! Explicit status only; never begins login. Native app supplies these paths.
use achmage_providers::{ClaudeHost, Config};
fn main() {
    let a: Vec<_> = std::env::args_os().collect();
    assert_eq!(a.len(), 4);
    let mut h = ClaudeHost::new(Config {
        executable: (&a[1]).into(),
        profile: (&a[2]).into(),
        cwd: (&a[3]).into(),
    })
    .unwrap();
    h.restore().unwrap();
    let start = std::time::Instant::now();
    loop {
        let s = h.state();
        if s["busy"] == false {
            println!("{s}");
            break;
        }
        assert!(start.elapsed().as_secs() < 25);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
