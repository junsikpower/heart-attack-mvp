import { useState, useEffect, useCallback } from 'react';

const FITNESS_API =
  'https://fitness.googleapis.com/fitness/v1/users/me/dataset:aggregate';

const POLL_INTERVAL_MS = 10_000; // 10초

export function useHeartRate(accessToken: string | null) {
  const [bpm, setBpm] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchHeartRate = useCallback(async () => {
    if (!accessToken) return;

    const now = Date.now();
    const fiveMinutesAgo = now - 24 * 60 * 60 * 1000; // 24시간 (수동 입력 포함)

    try {
      const res = await fetch(FITNESS_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }],
          bucketByTime: { durationMillis: 60_000 }, // 1분 단위 버킷
          startTimeMillis: fiveMinutesAgo,
          endTimeMillis: now,
        }),
      });

      if (res.status === 401) {
        // 토큰 만료 시 로컬 토큰 제거
        localStorage.removeItem('ha_google_token');
        setIsConnected(false);
        setError('로그인이 만료되었습니다. 다시 로그인해주세요.');
        return;
      }

      if (!res.ok) {
        setIsConnected(false);
        setError(`API 오류: ${res.status}`);
        return;
      }

      const data = await res.json();

      // 버킷 내 가장 최신 BPM 추출
      let latestBpm: number | null = null;
      for (const bucket of data.bucket ?? []) {
        for (const dataset of bucket.dataset ?? []) {
          for (const point of dataset.point ?? []) {
            const val = point.value?.[0]?.fpVal;
            if (val != null) {
              latestBpm = Math.round(val);
            }
          }
        }
      }

      if (latestBpm !== null) {
        setBpm(latestBpm);
        setIsConnected(true);
        setLastUpdated(new Date());
        setError(null);
      } else {
        // 5분 내 데이터 없음 (워치 미착용 등)
        setIsConnected(false);
        setError('최근 심박수 데이터가 없습니다.');
      }
    } catch {
      setIsConnected(false);
      setError('네트워크 오류');
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setBpm(null);
      setIsConnected(false);
      return;
    }
    fetchHeartRate(); // 즉시 1회 호출
    const id = setInterval(fetchHeartRate, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [accessToken, fetchHeartRate]);

  return { bpm, isConnected, lastUpdated, error };
}
