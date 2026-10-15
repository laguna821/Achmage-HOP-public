//! Explicit smoke test: one short synthetic prompt, no document/credential reads.
use hangul_ai_session::{cli::CliHost,bridge::Action};
use std::{path::PathBuf,time::{Duration,Instant}};
fn main(){
    let args:Vec<_>=std::env::args().collect();
    let mut host=CliHost::google(PathBuf::from(&args[1]),PathBuf::from(&args[2]));
    host.action(Action::BeginLogin{}).unwrap();
    let deadline=Instant::now()+Duration::from_secs(220);
    while host.state()["busy"]==true && Instant::now()<deadline {std::thread::sleep(Duration::from_millis(50));}
    let state=host.state();
    println!("connection={} models={}",state["auth"]["status"],state["models"].as_array().map_or(0,Vec::len));
    if state["auth"]["status"]!="signed_in"{std::process::exit(2);}
    host.action(Action::Send{reasoning_effort:None,prompt:"Reply with exactly HOP_OK. Do not use tools or access files.".into(),request_id:"owned-smoke".into(),model:None}).unwrap();
    while host.state()["busy"]==true && Instant::now()<deadline {std::thread::sleep(Duration::from_millis(50));}
    let state=host.state();
    println!("status={} text={} usage={}",state["turn"]["status"],state["turn"]["text"],state["usage"]);
    if state["turn"]["status"]!="completed"{std::process::exit(3);}
}
