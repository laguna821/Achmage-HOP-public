//! Owned official CLI process lifecycle. No credential files are read.
use serde_json::{Value, json};
use std::{io::{BufRead, BufReader, Read, Write}, path::PathBuf, process::{Command,Stdio}, sync::{Arc,Mutex,atomic::{AtomicBool,Ordering},mpsc}, thread, time::{Duration,Instant}};

pub struct CliHost {
    executable: PathBuf,
    cwd: PathBuf,
    state: Arc<Mutex<Value>>,
    cancelled: Arc<AtomicBool>,
}
impl CliHost {
    pub fn google(executable: PathBuf, cwd: PathBuf) -> Self {
        Self { executable, cwd, cancelled: Arc::new(AtomicBool::new(false)), state: Arc::new(Mutex::new(json!({
            "selectedProvider":"gemini","auth":{"status":"signed_out","sessionGeneration":null,"accountLabel":null},
            "usage":{"inputTokens":null,"outputTokens":null,"remainingPercent":null},"turn":{"id":null,"status":"idle","text":null},
            "busy":false,"commandPending":false,"sessionPersistence":"official_cli","notice":null,"models":[]
        }))) }
    }
    pub fn state(&self) -> Value { self.state.lock().unwrap().clone() }
    pub fn action(&mut self, action: crate::bridge::Action) -> Result<(),String> {
        use crate::bridge::Action;
        match action {
            Action::BeginLogin {} | Action::BeginConsoleLogin {} => self.connect(true),
            Action::RestoreConnection {} => self.connect(false),
            Action::CancelLogin {} => { self.cancelled.store(true, Ordering::SeqCst); Ok(()) },
            Action::CancelTurn { turn_id } => {
                if self.state.lock().unwrap()["turn"]["id"] != turn_id { return Err("응답이 변경되었습니다. 현재 작업을 확인하세요.".into()); }
                self.cancelled.store(true, Ordering::SeqCst); Ok(())
            },
            Action::Logout {} => {
                self.cancelled.store(true, Ordering::SeqCst);
                let mut state=self.state.lock().unwrap();
                state["auth"]=json!({"status":"signed_out","sessionGeneration":null});
                state["turn"]=json!({"id":null,"status":"idle","text":null});
                state["conversationId"]=Value::Null;
                state["notice"]=json!("이 앱의 연결을 해제했습니다. 공식 CLI 계정은 유지됩니다.");
                Ok(())
            },
            Action::Send { reasoning_effort: Some(_), .. } => Err("Gemini 추론 강도 선택은 지원하지 않습니다.".into()),
            Action::Send { prompt, request_id, model, .. } => self.send(prompt,request_id,model),
            Action::SelectProvider { .. } => Ok(()),
            Action::RefreshModels {} => self.connect(false),
        }
    }
    fn connect(&mut self, interactive:bool) -> Result<(),String> {
        let mut state=self.state.lock().unwrap();
        if state["busy"]==true { return Err("진행 중인 연결을 먼저 마치세요.".into()); }
        state["conversationId"]=Value::Null;
        state["busy"]=json!(true); state["auth"]["status"]=json!("pending"); state["auth"]["phase"]=json!("checking_account");state["notice"]=Value::Null;
        self.cancelled=Arc::new(AtomicBool::new(false));
        let (exe,cwd,shared,cancel)=(self.executable.clone(),self.cwd.clone(),self.state.clone(),self.cancelled.clone());
        thread::spawn(move || {
            let mut output=String::new();
            let mut result=run(&exe,&cwd,&["models".into()],None,&cancel,Duration::from_secs(30),None,|line| { output.push_str(line);output.push('\n'); Ok(()) });
            let mut models=parse_google_models(&output);
            if (result.is_err() || models.is_empty()) && interactive && !cancel.load(Ordering::SeqCst) {
                use achmage_runtime::login::{run_login,LoginOptions,LoginOutcome,LoginPhase};
                let login=run_login(&exe,&cwd,&cancel,LoginOptions::default(),|phase|{
                    let mut s=shared.lock().unwrap();
                    if !cancel.load(Ordering::SeqCst){s["auth"]["phase"]=json!(match phase{LoginPhase::Starting=>"starting_login",LoginPhase::WaitingForOfficialLogin=>"awaiting_browser",LoginPhase::CheckingAccount=>"checking_account",LoginPhase::Stopping=>"checking_account"});}
                },||{
                    let mut text=String::new();
                    let verified=run(&exe,&cwd,&["models".into()],None,&cancel,Duration::from_secs(10),None,|line|{text.push_str(line);text.push('\n');Ok(())}).is_ok();
                    if verified{models=parse_google_models(&text);}
                    Ok(verified&&!models.is_empty())
                });
                result=if matches!(login,Ok(LoginOutcome::Connected)){Ok(())}else{Err("login_incomplete".into())};
            }
            let mut s=shared.lock().unwrap();s["busy"]=json!(false);
            if cancel.load(Ordering::SeqCst) { s["auth"]["status"]=json!("signed_out"); return; }
            if result.is_ok() && !models.is_empty() {
                s["models"]=json!(models);s["auth"]=json!({"status":"signed_in","phase":"connected","sessionGeneration":format!("google-{}",unix_millis()),"accountLabel":"Google CLI","message":"사용 가능한 모델을 확인했습니다. 실제 요청 권한은 대화 결과로 확인합니다."});
            } else if !interactive {
                s["auth"]=json!({"status":"signed_out","phase":"signed_out","sessionGeneration":null});
            } else {
                s["auth"]=json!({"status":"error","phase":"checking_account","errorCode":"google_connection","message":"Google 연결을 확인하지 못했습니다. 공식 로그인 연결을 확인한 뒤 다시 시도하세요."});
            }
        });Ok(())
    }
    fn send(&mut self,prompt:String,request_id:String,model:Option<String>) -> Result<(),String> {
        if prompt.is_empty() { return Err("메시지 크기를 확인하세요.".into()); }
        let mut state=self.state.lock().unwrap();
        if state["busy"]==true || state["auth"]["status"]!="signed_in" { return Err("Google 연결을 먼저 확인하세요.".into()); }
        let selected=choose_google_model(state["models"].as_array().ok_or("모델 목록이 없습니다.")?,model)?;
        let account=state["auth"]["sessionGeneration"].clone();
        // The host sends explicit conversation context. A provider-side thread would leak previous app sessions.
        let conversation=None;
        state["turn"]=json!({"id":request_id,"requestId":request_id,"status":"running","text":""});state["busy"]=json!(true);state["notice"]=Value::Null;
        self.cancelled=Arc::new(AtomicBool::new(false));
        let (exe,cwd,shared,cancel)=(self.executable.clone(),self.cwd.clone(),self.state.clone(),self.cancelled.clone());
        thread::spawn(move || {
            let args=google_send_args(selected,conversation);
            let prompt=format!("You are the writing assistant embedded in HOP, a desktop word processor. The host application owns document editing. Return requested writing as plain text in your answer; the host will preview and apply it. Do not access files, run tools, or claim to have edited the document. When asked to write into the current document, produce the requested text instead of performing filesystem operations.\n\nUser request:\n{prompt}");
            let input=json!({"event":"user","message":{"content":prompt}}).to_string()+"\n";
            let mut parser=GoogleStream::default();
            // A long document streams for minutes: only two silent minutes or the 15-minute maximum end the turn.
            let result=run(&exe,&cwd,&args,Some(input.as_bytes()),&cancel,Duration::from_secs(900),Some(Duration::from_secs(120)),|line| {
                parser.push(line)?;
                let mut s=shared.lock().unwrap();
                if s["auth"]["sessionGeneration"]==account && s["turn"]["requestId"]==request_id && !cancel.load(Ordering::SeqCst) {
                    s["turn"]["text"]=json!(parser.text);
                }
                Ok(())
            });
            let mut s=shared.lock().unwrap();s["busy"]=json!(false);
            if s["auth"]["sessionGeneration"]!=account || s["turn"]["requestId"]!=request_id {return;}
            let status=if cancel.load(Ordering::SeqCst){"cancelled"}else if result.is_ok()&&parser.completed{"completed"}else{"error"};
            s["turn"]["status"]=json!(status);
            if status=="completed" {s["usage"]=json!({"inputTokens":parser.input,"outputTokens":parser.output,"remainingPercent":null,"source":"official_cli_result"});s["conversationId"]=json!(parser.conversation);}
            if status=="error" {s["turn"]["message"]=json!(if result.as_ref().err().map(String::as_str)==Some("empty_response"){"AI가 본문 없이 응답을 마쳤습니다. 작성할 내용을 다시 요청해 주세요."}else if result.as_ref().err().map(String::as_str)==Some("idle_timeout"){"AI가 2분 동안 아무 응답도 보내지 않아 멈췄습니다. 자동 재전송하지 않습니다."}else if result.as_ref().err().map(String::as_str)==Some("cancelled_or_timeout")&&!cancel.load(Ordering::SeqCst){"응답이 15분을 넘어 멈췄습니다. 자동 재전송하지 않습니다."}else{"응답을 완료하지 못했습니다. 연결 또는 모델 사용 권한을 확인하세요."});}
        });Ok(())
    }
}
impl Drop for CliHost {fn drop(&mut self){self.cancelled.store(true,Ordering::SeqCst);}}
fn unix_millis()->u128 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()}
/// The picker value must be one the official `agy models` listing returned; no value means its first row.
pub fn choose_google_model(models:&[Value],requested:Option<String>)->Result<String,String>{
    let selected=requested.or_else(||models.first()?.get("id")?.as_str().map(str::to_owned)).ok_or("모델을 선택하세요.")?;
    if !models.iter().any(|m|m["id"]==selected) {return Err("확인된 Google 모델을 선택하세요.".into());}
    Ok(selected)
}
pub fn google_send_args(model:String,conversation:Option<String>)->Vec<String>{
    let mut args:Vec<String>=["--input-format","stream-json","--output-format","stream-json","--mode","plan","--sandbox","--disable-slash-commands","--model"].into_iter().map(str::to_owned).collect();
    args.push(model);
    if let Some(id)=conversation { args.extend(["--conversation".into(),id]); }
    args
}
pub fn parse_google_models(raw:&str)->Vec<Value>{raw.lines().filter_map(|line|{let(id,label)=line.split_once('\t')?;let id=id.trim();if !id.starts_with("gemini-")||id.len()>100||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b"-._".contains(&b)){return None;}Some(json!({"id":id,"label":label.trim()}))}).collect()}
/// One stream-json line (`result` carries the whole answer), the answer text and the total output: memory bounds only.
pub const GOOGLE_LINE_LIMIT:usize=32*1024*1024;
pub const GOOGLE_TEXT_LIMIT:usize=32*1024*1024;
const GOOGLE_OUTPUT_LIMIT:usize=256*1024*1024;
#[derive(Default)]
pub struct GoogleStream {pub text:String,pub completed:bool,pub input:Option<u64>,pub output:Option<u64>,pub conversation:Option<String>}
impl GoogleStream {
    pub fn push(&mut self,line:&str)->Result<(),String>{
        if line.len()>GOOGLE_LINE_LIMIT{return Err("frame_limit".into());}
        let v:Value=serde_json::from_str(line).map_err(|_|"invalid_frame")?;
        if let Some(id)=v["result"]["conversation_id"].as_str().or_else(||v["conversation_id"].as_str()) {
            if id.len()<=256 && id.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b)){
                if self.conversation.as_deref().is_some_and(|prior|prior!=id){return Err("conversation_changed".into());}
                self.conversation=Some(id.to_owned());
            }
        }
        if self.completed{return Err("after_result".into());}
        match v["event"].as_str(){
            Some("step_update")=>{if let Some(text)=v["step_update"]["text_delta"].as_str(){if self.text.len()+text.len()>GOOGLE_TEXT_LIMIT{return Err("response_limit".into());}self.text.push_str(text);}},
            Some("result")=>{if v["result"]["status"]!="SUCCESS"{return Err("provider_failed".into());}let text=v["result"]["response"].as_str().ok_or("missing_response")?;if text.len()>GOOGLE_TEXT_LIMIT{return Err("response_limit".into());}if !text.trim().is_empty(){self.text=text.into();}if self.text.trim().is_empty(){return Err("empty_response".into());}self.completed=true;self.input=v["result"]["usage"]["input_tokens"].as_u64();self.output=v["result"]["usage"]["output_tokens"].as_u64();},
            Some("init")=>{},_=>{}
        }Ok(())
    }
}
// The last four are the Linux session (browser sign-in, Secret Service), never credentials.
pub const GOOGLE_CHILD_ENV:[&str;25]=["SystemRoot","WINDIR","PATH","PATHEXT","COMSPEC","TEMP","TMP","USERPROFILE","HOMEDRIVE","HOMEPATH","LOCALAPPDATA","APPDATA","ProgramData","ProgramFiles","ProgramFiles(x86)","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","OS","LANG","LC_ALL","HOME","DISPLAY","WAYLAND_DISPLAY","DBUS_SESSION_BUS_ADDRESS","XDG_RUNTIME_DIR"];
fn run(exe:&PathBuf,cwd:&PathBuf,args:&[String],input:Option<&[u8]>,cancel:&AtomicBool,timeout:Duration,idle:Option<Duration>,mut line:impl FnMut(&str)->Result<(),String>)->Result<(),String>{
    let mut command=Command::new(exe);command.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // OS runtime and the user's own profile folders (where the official CLI keeps its sign-in) only:
    // no provider keys, tokens, proxies or debug switches reach the child.
    command.env_clear();
    for key in GOOGLE_CHILD_ENV{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let mut child=command.spawn().map_err(|_|"runtime_start")?;
    // A long prompt is written on its own thread while stdout is read, so a child that answers (or fills its
    // stdout pipe) before reading all of stdin can never deadlock the turn.
    let writer=match (input,child.stdin.take()) {
        (Some(input),Some(mut stdin))=>{let bytes=input.to_vec();Some(thread::spawn(move||stdin.write_all(&bytes).is_ok()))},
        _=>None,
    };
    let stdout=child.stdout.take().unwrap();let mut stderr=child.stderr.take().unwrap();
    let (tx,rx)=mpsc::sync_channel(64);
    let reader=thread::spawn(move||{let mut r=BufReader::new(stdout);loop{let mut bytes=Vec::new();match r.by_ref().take(GOOGLE_LINE_LIMIT as u64+1).read_until(b'\n',&mut bytes){Ok(0)=>break,Ok(_) if bytes.len()<=GOOGLE_LINE_LIMIT=>{let parsed=String::from_utf8(bytes).map_err(|_|"invalid_utf8".to_owned());if tx.send(parsed).is_err(){break;}},_=>{let _=tx.send(Err("frame_limit".into()));break;}}}});
    let error_reader=thread::spawn(move||{let mut buf=[0u8;4096];while let Ok(n)=stderr.read(&mut buf){if n==0{break;}}});
    let start=Instant::now();let mut last=start;let mut count=0;let mut failure=None;
    loop{
        if cancel.load(Ordering::SeqCst)||start.elapsed()>timeout {failure=Some("cancelled_or_timeout".to_owned());break;}
        if idle.is_some_and(|idle|last.elapsed()>idle) {failure=Some("idle_timeout".to_owned());break;}
        match rx.recv_timeout(Duration::from_millis(30)){
            Ok(Ok(text))=>{last=Instant::now();count+=text.len();if count>GOOGLE_OUTPUT_LIMIT{failure=Some("output_limit".into());break;}if !text.trim().is_empty(){if let Err(e)=line(text.trim_end()){failure=Some(e);break;}}},
            Ok(Err(e))=>{failure=Some(e);break;},
            Err(mpsc::RecvTimeoutError::Disconnected)=>break,
            Err(mpsc::RecvTimeoutError::Timeout)=>{}
        }
    }
    if failure.is_some(){let _=child.kill();}
    // Reader EOF precedes exit in normal CLI mode; bound final process settlement too.
    while matches!(child.try_wait(),Ok(None)){if start.elapsed()>timeout||cancel.load(Ordering::SeqCst){let _=child.kill();failure.get_or_insert("cancelled_or_timeout".into());break;}thread::sleep(Duration::from_millis(20));}
    let status=child.wait().map_err(|_|"exit")?;drop(rx);let _=reader.join();let _=error_reader.join();
    // The child has exited, so its stdin is closed and the writer has finished.
    if writer.is_some_and(|w|!w.join().unwrap_or(false)){failure.get_or_insert("stdin".into());}
    if let Some(e)=failure{return Err(e);}if !status.success(){return Err("provider_exit".into());}Ok(())
}

#[cfg(test)] mod tests{
    use super::*;
    #[test]fn chosen_listed_model_reaches_the_cli_and_unlisted_is_refused(){let models=parse_google_models("gemini-a\tA\ngemini-b\tB");assert_eq!(choose_google_model(&models,Some("gemini-b".into())).unwrap(),"gemini-b");assert_eq!(choose_google_model(&models,None).unwrap(),"gemini-a");assert!(choose_google_model(&models,Some("gemini-guess".into())).is_err());assert!(choose_google_model(&[],None).is_err());let args=google_send_args("gemini-b".into(),Some("c1".into()));let at=args.iter().position(|a|a=="--model").unwrap();assert_eq!(args[at+1],"gemini-b");assert_eq!(&args[args.len()-2..],&["--conversation".to_owned(),"c1".to_owned()]);}
    #[test]fn reasoning_effort_is_refused_before_any_cli_starts(){let mut h=CliHost::google(PathBuf::from("missing-agy"),std::env::temp_dir());let e=h.action(crate::bridge::Action::Send{request_id:"r1".into(),prompt:"질문".into(),model:None,reasoning_effort:Some("high".into())}).unwrap_err();assert!(e.contains("추론 강도"));assert_eq!(h.state()["busy"],false);}
    #[test]fn child_environment_never_carries_keys_or_proxies(){for key in GOOGLE_CHILD_ENV{let k=key.to_ascii_uppercase();assert!(!k.contains("KEY")&&!k.contains("TOKEN")&&!k.contains("PROXY")&&!k.contains("SECRET")&&!k.starts_with("GOOGLE")&&!k.starts_with("GEMINI")&&!k.starts_with("OPENAI")&&!k.starts_with("ANTHROPIC")&&!k.starts_with("XAI"),"{key}");}}
    /// Streaming keeps a turn alive for as long as it needs; a child that falls silent is stopped at the idle limit.
    #[test]fn a_silent_turn_stops_at_the_idle_limit_and_keeps_what_it_already_streamed(){
        let (exe,args):(PathBuf,Vec<String>)=if cfg!(windows){(PathBuf::from(std::env::var_os("COMSPEC").unwrap_or_else(||"cmd.exe".into())),vec!["/C".into(),"echo first& ping -n 6 127.0.0.1 >nul& echo late".into()])}else{(PathBuf::from("/bin/sh"),vec!["-c".into(),"echo first; sleep 5; echo late".into()])};
        let cancel=AtomicBool::new(false);let mut lines=Vec::new();
        let error=run(&exe,&std::env::temp_dir(),&args,None,&cancel,Duration::from_secs(60),Some(Duration::from_millis(1500)),|line|{lines.push(line.to_owned());Ok(())}).unwrap_err();
        assert_eq!(error,"idle_timeout");assert_eq!(lines,["first"]);
    }
    #[test]fn catalog_filters_non_google_and_invalid_ids(){assert_eq!(parse_google_models("Fetching...\ngemini-a\tGoogle A\nclaude-x\tOther\ngemini- ; rm\tBad").len(),1);}
    #[test]fn success_requires_terminal_result_and_keeps_usage(){let mut p=GoogleStream::default();p.push(r#"{"event":"step_update","step_update":{"text_delta":"가"}}"#).unwrap();assert!(!p.completed);p.push(r#"{"event":"result","result":{"status":"SUCCESS","response":"가나","usage":{"input_tokens":12,"output_tokens":2}}}"#).unwrap();assert_eq!(p.text,"가나");assert_eq!(p.input,Some(12));assert!(p.completed);assert!(p.push(r#"{"event":"init"}"#).is_err());}
    #[test]fn provider_failure_and_invalid_json_are_not_success(){let mut p=GoogleStream::default();assert!(p.push("not json").is_err());assert!(p.push(r#"{"event":"result","result":{"status":"ERROR","response":"partial"}}"#).is_err());assert!(!p.completed);}
    #[test]fn empty_success_is_not_an_answer_and_cannot_erase_streamed_text(){let mut p=GoogleStream::default();assert_eq!(p.push(r#"{"event":"result","result":{"status":"SUCCESS","response":""}}"#).unwrap_err(),"empty_response");assert!(!p.completed);p.push(r#"{"event":"step_update","step_update":{"text_delta":"소설 본문"}}"#).unwrap();p.push(r#"{"event":"result","result":{"status":"SUCCESS","response":""}}"#).unwrap();assert_eq!(p.text,"소설 본문");assert!(p.completed);}
}
