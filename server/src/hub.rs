//! In-process wake-ups for `wait` and streams, and the registry of open listeners.
//!
//! A room's watch channel is bumped on every change (new event, presence, deletion). Waiters then
//! re-read the database, so the channel carries no data. Other server instances are picked up by the
//! periodic re-check in `wait`/stream loops.

use std::{collections::HashMap, sync::Mutex};

use tokio::sync::watch;

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<HashMap<String, watch::Sender<u64>>>,
    listeners: Mutex<HashMap<(String, String), usize>>,
}

impl Hub {
    /// A receiver that changes whenever `room` changes.
    pub fn subscribe(&self, room: &str) -> watch::Receiver<u64> {
        let mut rooms = self.rooms.lock().unwrap();
        rooms.entry(room.to_owned()).or_insert_with(|| watch::channel(0).0).subscribe()
    }

    pub fn notify(&self, room: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        if let Some(tx) = rooms.get(room) {
            if tx.receiver_count() == 0 {
                rooms.remove(room);
            } else {
                tx.send_modify(|v| *v = v.wrapping_add(1));
            }
        }
    }

    /// Drops channels nobody listens to.
    pub fn sweep(&self) {
        self.rooms.lock().unwrap().retain(|_, tx| tx.receiver_count() > 0);
    }

    /// Registers an open wait/stream for `sender`; true if it is the first one on this instance.
    pub fn listen_start(&self, room: &str, sender: &str) -> bool {
        let mut map = self.listeners.lock().unwrap();
        let n = map.entry((room.to_owned(), sender.to_owned())).or_insert(0);
        *n += 1;
        *n == 1
    }

    /// Unregisters one wait/stream; true if it was the last one on this instance.
    pub fn listen_end(&self, room: &str, sender: &str) -> bool {
        let mut map = self.listeners.lock().unwrap();
        let key = (room.to_owned(), sender.to_owned());
        match map.get_mut(&key) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            Some(_) => {
                map.remove(&key);
                true
            }
            None => false,
        }
    }

    pub fn is_listening(&self, room: &str, sender: &str) -> bool {
        self.listeners.lock().unwrap().contains_key(&(room.to_owned(), sender.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notify_wakes_subscribers() {
        let hub = Hub::default();
        let mut rx = hub.subscribe("r");
        hub.notify("r");
        rx.changed().await.unwrap();
        hub.notify("other");
        drop(rx);
        hub.notify("r");
        assert!(hub.rooms.lock().unwrap().is_empty());
    }

    #[test]
    fn listener_counts() {
        let hub = Hub::default();
        assert!(hub.listen_start("r", "a"));
        assert!(!hub.listen_start("r", "a"));
        assert!(hub.is_listening("r", "a"));
        assert!(!hub.listen_end("r", "a"));
        assert!(hub.listen_end("r", "a"));
        assert!(!hub.is_listening("r", "a"));
        assert!(!hub.listen_end("r", "a"));
    }
}
