//! API errors: `{error, message}` bodies with the status codes of PROTOCOL §6.3.

use std::fmt::Display;

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    message: &'a str,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), retry_after: None }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "auth", message)
    }

    pub fn room_full(max: i64) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "room_full",
            format!("this room already has the maximum of {max} participants"),
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn room_deleted(purge_at: Option<i64>) -> Self {
        let message = match purge_at {
            Some(at) => format!("this room was deleted; it can be restored until {at} (unix ms)"),
            None => "this room was deleted".to_owned(),
        };
        Self::new(StatusCode::GONE, "room_deleted", message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", message)
    }

    pub fn rate_limited(retry_after_secs: u64) -> Self {
        let mut e = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            format!("rate limit exceeded; retry in {retry_after_secs} s"),
        );
        e.retry_after = Some(retry_after_secs);
        e
    }

    pub fn quota_exceeded(quota: i64) -> Self {
        Self::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "quota_exceeded",
            format!("room storage quota of {quota} bytes exceeded"),
        )
    }

    /// An unexpected server-side failure. The cause is logged, never returned to the client.
    pub fn internal(cause: impl Display) -> Self {
        tracing::error!(error = %cause, "internal error");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal server error")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status.as_u16(), self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(format_args!("database: {e}"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(format_args!("{e:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody { error: self.code, message: &self.message };
        let mut res = (self.status, Json(body)).into_response();
        if let Some(secs) = self.retry_after {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        res
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
