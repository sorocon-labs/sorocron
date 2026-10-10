//! Prometheus metrics and a liveness probe, served on `METRICS_PORT`:
//!
//!   GET /metrics   Prometheus text format, same names as the TypeScript keeper
//!   GET /healthz   200 while ticks succeed, 503 once the last success is
//!                  older than three poll intervals (at least a minute)

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Counter,
    Gauge,
}

struct Metric {
    kind: Kind,
    help: &'static str,
    /// Value per label set, rendered in order.
    values: BTreeMap<String, f64>,
}

/// Metric store shared between the keeper loop and the HTTP server.
#[derive(Default)]
pub struct Metrics {
    metrics: Mutex<BTreeMap<&'static str, Metric>>,
    /// Unix milliseconds of the last successful tick, 0 before the first.
    last_success_ms: Mutex<u64>,
}

fn labels(pairs: &[(&str, &str)]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let inner: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}=\"{v}\"")).collect();
    format!("{{{}}}", inner.join(","))
}

impl Metrics {
    fn update(
        &self,
        name: &'static str,
        kind: Kind,
        help: &'static str,
        pairs: &[(&str, &str)],
        f: impl FnOnce(&mut f64),
    ) {
        let mut metrics = self.metrics.lock().unwrap();
        let metric = metrics.entry(name).or_insert_with(|| Metric {
            kind,
            help,
            values: BTreeMap::new(),
        });
        f(metric.values.entry(labels(pairs)).or_insert(0.0));
    }

    pub fn inc(&self, name: &'static str, help: &'static str, pairs: &[(&str, &str)], by: f64) {
        self.update(name, Kind::Counter, help, pairs, |v| *v += by);
    }

    pub fn set(&self, name: &'static str, help: &'static str, value: f64) {
        self.update(name, Kind::Gauge, help, &[], |v| *v = value);
    }

    pub fn record_success(&self, at_ms: u64) {
        *self.last_success_ms.lock().unwrap() = at_ms;
    }

    /// Healthy once a tick has succeeded within `stale_after`.
    pub fn healthy(&self, now_ms: u64, stale_after: Duration) -> bool {
        let last = *self.last_success_ms.lock().unwrap();
        last > 0 && now_ms.saturating_sub(last) <= stale_after.as_millis() as u64
    }

    pub fn render(&self) -> String {
        let metrics = self.metrics.lock().unwrap();
        let mut out = String::new();
        for (name, metric) in metrics.iter() {
            let kind = match metric.kind {
                Kind::Counter => "counter",
                Kind::Gauge => "gauge",
            };
            out += &format!("# HELP {name} {}\n# TYPE {name} {kind}\n", metric.help);
            for (labels, value) in &metric.values {
                out += &format!("{name}{labels} {value}\n");
            }
        }
        out
    }

    /// Status, content type and body for a request path.
    pub fn respond(
        &self,
        path: &str,
        now_ms: u64,
        stale_after: Duration,
    ) -> (u16, &'static str, String) {
        match path {
            "/metrics" => (200, "text/plain; version=0.0.4", self.render()),
            "/healthz" => {
                let ok = self.healthy(now_ms, stale_after);
                let last = *self.last_success_ms.lock().unwrap();
                let body = format!(
                    r#"{{"ok":{ok},"lastSuccessMs":{}}}"#,
                    if last > 0 {
                        last.to_string()
                    } else {
                        "null".into()
                    }
                );
                (if ok { 200 } else { 503 }, "application/json", body)
            }
            _ => (404, "text/plain", "not found\n".into()),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Serves `/metrics` and `/healthz` until the process exits.
pub async fn serve(listener: TcpListener, metrics: Arc<Metrics>, stale_after: Duration) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        let metrics = metrics.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("GET "))
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or("");
            let (status, content_type, body) = metrics.respond(path, now_ms(), stale_after);
            let reason = match status {
                200 => "OK",
                503 => "Service Unavailable",
                _ => "Not Found",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_prometheus_text() {
        let m = Metrics::default();
        m.inc(
            "sorocron_keeper_ticks_total",
            "Completed polling passes",
            &[],
            1.0,
        );
        m.inc(
            "sorocron_keeper_ticks_total",
            "Completed polling passes",
            &[],
            1.0,
        );
        m.inc(
            "sorocron_keeper_jobs_total",
            "Due jobs by outcome",
            &[("outcome", "executed")],
            3.0,
        );
        m.set(
            "sorocron_keeper_jobs_due",
            "Jobs that looked due in the last tick",
            4.0,
        );
        assert_eq!(
            m.render(),
            "# HELP sorocron_keeper_jobs_due Jobs that looked due in the last tick\n\
             # TYPE sorocron_keeper_jobs_due gauge\n\
             sorocron_keeper_jobs_due 4\n\
             # HELP sorocron_keeper_jobs_total Due jobs by outcome\n\
             # TYPE sorocron_keeper_jobs_total counter\n\
             sorocron_keeper_jobs_total{outcome=\"executed\"} 3\n\
             # HELP sorocron_keeper_ticks_total Completed polling passes\n\
             # TYPE sorocron_keeper_ticks_total counter\n\
             sorocron_keeper_ticks_total 2\n"
        );
    }

    #[test]
    fn health_goes_stale() {
        let m = Metrics::default();
        let stale = Duration::from_secs(60);
        assert!(!m.healthy(1_000_000, stale));
        assert_eq!(m.respond("/healthz", 1_000_000, stale).0, 503);
        m.record_success(1_000_000);
        assert!(m.healthy(1_060_000, stale));
        assert!(!m.healthy(1_060_001, stale));
        let (status, kind, body) = m.respond("/healthz", 1_000_500, stale);
        assert_eq!((status, kind), (200, "application/json"));
        assert_eq!(body, r#"{"ok":true,"lastSuccessMs":1000000}"#);
        assert_eq!(m.respond("/nope", 0, stale).0, 404);
    }

    #[tokio::test]
    async fn serves_over_http() {
        let m = Arc::new(Metrics::default());
        m.set(
            "sorocron_keeper_jobs_due",
            "Jobs that looked due in the last tick",
            2.0,
        );
        m.record_success(now_ms());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, m, Duration::from_secs(60)));

        for (path, expect) in [
            ("/metrics", "sorocron_keeper_jobs_due 2"),
            ("/healthz", "200 OK"),
        ] {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nhost: x\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            assert!(response.contains(expect), "{path}: {response}");
        }
    }
}
