//! Test-only owned child. It never opens a browser or reads account data.
use std::{
    io::{self, Write},
    thread,
    time::Duration,
};
fn main() {
    println!("owned fixture ready");
    io::stdout().flush().unwrap();
    loop {
        thread::sleep(Duration::from_millis(50));
    }
}
