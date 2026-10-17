//! Blob byte storage: a local directory (default) or an S3-compatible bucket (`s3` feature).
//!
//! Objects live at `<room id>/<blob id>`. Both ids are validated base64url, so they are safe as path
//! segments. Blob metadata and quotas are tracked in the database; this layer only moves bytes.

use std::{io::ErrorKind, path::PathBuf};

use anyhow::{Context, bail};
use bytes::Bytes;

use crate::config::Config;

pub enum BlobStore {
    Local(LocalStore),
    #[cfg(feature = "s3")]
    S3(s3::S3Store),
}

impl BlobStore {
    pub async fn from_config(config: &Config) -> anyhow::Result<Self> {
        match config.blob_url.as_deref() {
            None => LocalStore::open(config.blob_dir.clone()).await.map(Self::Local),
            Some(url) if url.starts_with("file://") => {
                LocalStore::open(PathBuf::from(&url["file://".len()..])).await.map(Self::Local)
            }
            Some(url) if url.starts_with("s3://") => {
                #[cfg(feature = "s3")]
                {
                    s3::S3Store::open(url).map(Self::S3)
                }
                #[cfg(not(feature = "s3"))]
                {
                    bail!("LINCOR_BLOB_URL={url} needs a build with the `s3` feature")
                }
            }
            Some(url) => bail!("unsupported LINCOR_BLOB_URL {url:?} (expected s3://bucket/prefix or file:///path)"),
        }
    }

    pub async fn put(&self, room: &str, id: &str, bytes: Bytes) -> anyhow::Result<()> {
        match self {
            Self::Local(s) => s.put(room, id, bytes).await,
            #[cfg(feature = "s3")]
            Self::S3(s) => s.put(room, id, bytes).await,
        }
    }

    pub async fn get(&self, room: &str, id: &str) -> anyhow::Result<Option<Bytes>> {
        match self {
            Self::Local(s) => s.get(room, id).await,
            #[cfg(feature = "s3")]
            Self::S3(s) => s.get(room, id).await,
        }
    }

    /// Deletes blobs of one room (missing objects are not an error).
    pub async fn delete(&self, room: &str, ids: &[String]) -> anyhow::Result<()> {
        match self {
            Self::Local(s) => s.delete(room, ids).await,
            #[cfg(feature = "s3")]
            Self::S3(s) => s.delete(room, ids).await,
        }
    }
}

pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    pub async fn open(root: PathBuf) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all(&root)
            .await
            .with_context(|| format!("creating blob directory {}", root.display()))?;
        Ok(Self { root })
    }

    fn path(&self, room: &str, id: &str) -> PathBuf {
        self.root.join(room).join(id)
    }

    async fn put(&self, room: &str, id: &str, bytes: Bytes) -> anyhow::Result<()> {
        let dir = self.root.join(room);
        tokio::fs::create_dir_all(&dir).await?;
        // Write to a temporary name first so readers never see a partial blob.
        let tmp = dir.join(format!(".{id}.{:016x}.tmp", rand::random::<u64>()));
        tokio::fs::write(&tmp, &bytes).await?;
        if let Err(e) = tokio::fs::rename(&tmp, self.path(room, id)).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        Ok(())
    }

    async fn get(&self, room: &str, id: &str) -> anyhow::Result<Option<Bytes>> {
        match tokio::fs::read(self.path(room, id)).await {
            Ok(v) => Ok(Some(Bytes::from(v))),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn delete(&self, room: &str, ids: &[String]) -> anyhow::Result<()> {
        for id in ids {
            match tokio::fs::remove_file(self.path(room, id)).await {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        // Remove the room directory once it is empty; failure just means other blobs remain.
        let _ = tokio::fs::remove_dir(self.root.join(room)).await;
        Ok(())
    }
}

#[cfg(feature = "s3")]
mod s3 {
    use std::sync::Arc;

    use anyhow::{Context, bail};
    use bytes::Bytes;
    use object_store::{ObjectStore, aws::AmazonS3Builder, path::Path};

    /// S3-compatible storage. Credentials, region and endpoint come from the standard `AWS_*`
    /// environment variables (`AWS_ENDPOINT` and `AWS_ALLOW_HTTP` for MinIO, R2 and the like).
    pub struct S3Store {
        store: Arc<dyn ObjectStore>,
        prefix: Path,
    }

    impl S3Store {
        pub fn open(url: &str) -> anyhow::Result<Self> {
            let rest = url.strip_prefix("s3://").unwrap_or(url);
            let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
            if bucket.is_empty() {
                bail!("LINCOR_BLOB_URL must name a bucket: s3://bucket/prefix");
            }
            let store = AmazonS3Builder::from_env().with_bucket_name(bucket).build().context("configuring S3")?;
            let prefix = Path::parse(prefix.trim_matches('/')).context("invalid S3 prefix")?;
            Ok(Self { store: Arc::new(store), prefix })
        }

        fn path(&self, room: &str, id: &str) -> Path {
            self.prefix.child(room).child(id)
        }

        pub async fn put(&self, room: &str, id: &str, bytes: Bytes) -> anyhow::Result<()> {
            self.store.put(&self.path(room, id), bytes.into()).await?;
            Ok(())
        }

        pub async fn get(&self, room: &str, id: &str) -> anyhow::Result<Option<Bytes>> {
            match self.store.get(&self.path(room, id)).await {
                Ok(r) => Ok(Some(r.bytes().await?)),
                Err(object_store::Error::NotFound { .. }) => Ok(None),
                Err(e) => Err(e.into()),
            }
        }

        pub async fn delete(&self, room: &str, ids: &[String]) -> anyhow::Result<()> {
            for id in ids {
                match self.store.delete(&self.path(room, id)).await {
                    Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(())
        }
    }
}
