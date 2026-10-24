// Requires k6: k6 run bench/upload.k6.js
// Does not run in PR CI: benchmark environment and load can vary widely.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const failed = new Rate('incorrect_response');
const fixture = open('../tests/fixtures/cbr.mp3', 'b');

export const options = {
  scenarios: {
    mp3_upload: {
      executor: 'constant-vus',
      vus: 5,
      duration: '20s',
    },
  },
  thresholds: {
    incorrect_response: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const response = http.post(__ENV.BASE_URL ?? 'http://127.0.0.1:3000/file-upload', {
    file: http.file(fixture, 'cbr.mp3', 'audio/mpeg'),
  });
  const valid = check(response, {
    'status 200': (r) => r.status === 200,
    'valid frame count': (r) => r.json('frameCount') === 33,
  });
  failed.add(!valid);
}
