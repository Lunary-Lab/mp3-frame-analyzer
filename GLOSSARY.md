# MP3 frame analyzer

A service that receives one MP3 file and reports how many MPEG-1 Layer III frames it contains.

## Uploads

**Upload**:
One MP3 file's bytes as a client sends them to `POST /file-upload`, in one of two forms.
_Avoid_: body, file, payload

**Raw upload**:
An upload sent as the entire request body, labelled with an accepted MP3 media type.
_Avoid_: binary upload, direct upload

**Multipart upload**:
An upload sent as the single form part named `file` in a multipart form.
_Avoid_: form upload, file part

**Unread remainder**:
The part of an upload the service has not read yet when it decides to reject that upload.
_Avoid_: leftover body, rejected body
