# MP3 frame analyzer

A service that receives one MP3 file and reports how many MPEG-1 Layer III frames it contains.

## Uploads

**Upload**:
One MP3 file's bytes as a client sends them to `POST /file-upload`, in one of two forms.
_Avoid_: body, file, payload

**Raw upload**:
An upload sent as the entire request body rather than inside a multipart form.
_Avoid_: binary upload, direct upload

**Multipart upload**:
An upload sent as the single form part named `file` in a multipart form.
_Avoid_: form upload, file part

**Unread remainder**:
The part of an upload the service has not read yet when it decides to reject that upload.
_Avoid_: leftover body, rejected body

## Metadata

**Leading tag**:
An ID3v2 tag before the first MPEG frame; at most eight may precede the audio.
_Avoid_: header tag, prefix

**Trailing metadata**:
The ID3 tags after the last MPEG frame: at most one appended ID3v2.4 tag with a footer, then at most one ID3v1 tag, and nothing after them.
_Avoid_: trailer, trailing tags
