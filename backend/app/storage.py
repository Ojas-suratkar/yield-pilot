"""Object storage: the Cloud Storage bucket, also when the API runs on a laptop."""

from datetime import timedelta

from .config import settings


class GCSStorage:
    def __init__(self, bucket: str):
        from google.cloud import storage

        self.client = storage.Client(project=settings().gcp_project or None)
        self.bucket = self.client.bucket(bucket)

    def upload_url(self, key: str, content_type: str, upload_id: str) -> tuple[str, dict]:
        import google.auth
        from google.auth.transport.requests import Request

        creds, _ = google.auth.default()
        creds.refresh(Request())
        sa = getattr(creds, "service_account_email", None)
        if not sa:  # a person's own Google sign-in (the API on a laptop) can't sign URLs: the file goes through the API
            return f"/api/v1/datasets/uploads/{upload_id}/content", {"Content-Type": content_type}
        url = self.bucket.blob(key).generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=15),
            method="PUT",
            content_type=content_type,
            service_account_email=sa,
            access_token=creds.token,
        )
        return url, {"Content-Type": content_type}

    def write_file(self, key: str, src: str) -> None:
        self.bucket.blob(key).upload_from_filename(src)

    def download(self, key: str, dest: str) -> None:
        self.bucket.blob(key).download_to_filename(dest)

    def exists(self, key: str) -> bool:
        return self.bucket.blob(key).exists()

    def delete(self, key: str) -> None:
        blob = self.bucket.blob(key)
        if blob.exists():
            blob.delete()

    def delete_prefix(self, prefix: str) -> None:
        for b in self.bucket.list_blobs(prefix=prefix):
            b.delete()

    def open_write(self, key: str):
        return self.bucket.blob(key).open("wb")


_store = None


def storage() -> GCSStorage:
    global _store
    if _store is None:
        _store = GCSStorage(settings().gcs_bucket)
    return _store
