use achmage_research::{secrets::MemorySecrets, types::*, ResearchService};
use std::sync::Arc;
#[tokio::main]
async fn main() {
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    let mut results = Vec::new();
    for source in ["crossref", "europe-pmc", "openalex", "pubmed"] {
        let r = SearchRequest {
            source_id: source.into(),
            query: "artificial intelligence education".into(),
            limit: 2,
            cursor: None,
        };
        let id = service.start(r.clone()).unwrap();
        loop {
            let state = service.poll(&id).unwrap();
            if matches!(state, JobState::Running) {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            let cache = if matches!(state, JobState::Completed { .. }) {
                let cached = service.start(r.clone()).unwrap();
                Some(service.poll(&cached).unwrap())
            } else {
                None
            };
            results.push(serde_json::json!({"source":source,"state":state,"cacheRepeat":cache}));
            break;
        }
    }
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
    service.shutdown();
}
