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

## Frames

**Physical frame**:
One complete MPEG-1 Layer III frame present in the stream, whatever its payload carries.
_Avoid_: audio frame, packet

**Frame span**:
A physical frame's length in bytes: from the bitrate table for an indexed frame, or a free-format stream's base length plus the frame's padding.
_Avoid_: frame size, frame length (in prose)

**Encoder frame**:
An initial physical frame with a structurally recognized Xing/Info or VBRI encoder header; the HTTP default count excludes it. Recognition does not establish whether its payload contains decodable audio. See the [counting contract](docs/frame-count-contract.md).
_Avoid_: VBR header, Xing header, metadata frame

## Metadata

**Leading tag**:
An ID3v2 tag before the first MPEG frame; each tag is streamed by its encoded size without a tag-count cap.
_Avoid_: header tag, prefix

**Trailing metadata**:
The ID3 tags after the last MPEG frame: consecutive appended ID3v2.4 tags, each with a footer, then at most one ID3v1 tag, and nothing after them.
_Avoid_: trailer, trailing tags

**Embedded tag**:
An ID3v2 tag between MPEG frames. Consecutive tags may occur at one boundary; traversal resumes in the same audio mode. Each tag consumes at least its header bytes.
