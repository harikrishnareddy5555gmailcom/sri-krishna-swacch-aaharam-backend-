import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const TARGET_USERS = Number(__ENV.USERS || 50);

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '30s', target: 10 },
    { duration: '1m', target: 25 },
    { duration: '1m', target: TARGET_USERS },
    { duration: '2m', target: TARGET_USERS },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const live = http.get(`${BASE_URL}/api/v1/health/live`, {
    tags: { endpoint: 'live' },
  });
  check(live, {
    'live status is 200': (r) => r.status === 200,
  });

  const ready = http.get(`${BASE_URL}/api/v1/health/ready`, {
    tags: { endpoint: 'ready' },
  });
  check(ready, {
    'ready status is 200': (r) => r.status === 200,
  });

  const products = http.get(
    `${BASE_URL}/api/v1/catalog/products?page=1&limit=20`,
    { tags: { endpoint: 'products' } }
  );
  check(products, {
    'products status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
