import { useState, useEffect, useRef, useCallback } from 'react';

export type MeasurementStatus = 'idle' | 'initializing' | 'measuring' | 'error' | 'no_finger';

interface CameraHeartRateResult {
  bpm: number | null;
  status: MeasurementStatus;
  waveform: number[];
  error: string | null;
  stream: MediaStream | null;
  startMeasurement: () => Promise<void>;
  stopMeasurement: () => void;
}

const BUFFER_SIZE = 150; // 약 5초 분량 (30 FPS 기준)
const FPS_INTERVAL = 1000 / 30; // 30 FPS 타겟

export function useCameraHeartRate(): CameraHeartRateResult {
  const [bpm, setBpm] = useState<number | null>(null);
  const [status, setStatus] = useState<MeasurementStatus>('idle');
  const [waveform, setWaveform] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafId = useRef<number | null>(null);
  const lastDrawTime = useRef<number>(0);
  
  // 알고리즘 변수
  const rawSignalBuffer = useRef<number[]>([]);
  const timeBuffer = useRef<number[]>([]);
  const peakTimestamps = useRef<number[]>([]);
  const currentBpmRef = useRef<number | null>(null); // EMA 적용을 위해 직전 BPM 저장

  const stopMeasurement = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoElementRef.current) {
      videoElementRef.current.srcObject = null;
    }
    setActiveStream(null);
    setStatus('idle');
    setBpm(null);
    setWaveform([]);
    rawSignalBuffer.current = [];
    timeBuffer.current = [];
    peakTimestamps.current = [];
    currentBpmRef.current = null;
  }, []);

  const calculateBPM = useCallback(() => {
    const raw = rawSignalBuffer.current;
    if (raw.length < 30) return; // 최소 1초 이상의 데이터 수집 대기

    // 1. Data Normalization (실시간 최소/최대값 기준 영점 조정 및 스케일링)
    // 최근 2초(60프레임) 데이터만 분석하여 환경(광량/압력) 변화에 강건하게 반응
    const recentRaw = raw.slice(-60);
    const minRaw = Math.min(...recentRaw);
    const maxRaw = Math.max(...recentRaw);
    const range = maxRaw - minRaw;

    // 노이즈(파장이 전혀 없는 상태) 무시
    if (range < 0.5) return; 

    const filtered: number[] = [];
    const timestamps = timeBuffer.current;

    for (let i = 0; i < raw.length; i++) {
        // High-pass 대체: 윈도우 기반 Min/Max 보정으로 DC offset(기울어짐) 제거
        const normalized = (raw[i] - minRaw) / range;
        filtered.push(normalized);
    }
    
    // 2. Low-pass Filter (Moving Average)
    // 자잘한 프레임 노이즈 및 손떨림 고주파 제거
    const smoothed: number[] = [];
    const windowSize = 5;
    for (let i = 0; i < filtered.length; i++) {
        if (i < windowSize) {
           smoothed.push(filtered[i]);
        } else {
           let sum = 0;
           for(let j=0; j<windowSize; j++) sum += filtered[i-j];
           smoothed.push(sum / windowSize);
        }
    }

    // Waveform UI 업데이트 (최근 100프레임)
    setWaveform(smoothed.slice(-100));

    // 3. Peak Detection (부드러운 신호 위에서 피크 찾기)
    if (smoothed.length < 3) return;
    
    const v0 = smoothed[smoothed.length - 3];
    const v1 = smoothed[smoothed.length - 2];
    const v2 = smoothed[smoothed.length - 1];
    
    // 진폭이 정규화 평균치(0.5)를 넘는 명확한 최고점인지 검사
    if (v1 > v0 && v1 > v2 && v1 > 0.4) { 
        const peakTime = timestamps[timestamps.length - 2];
        const lastPeakTime = peakTimestamps.current[peakTimestamps.current.length - 1] || 0;
        
        // 4. Band-pass Filter (생리학적 주파수 대역 적용)
        // 0.7Hz ~ 3.5Hz (약 42 BPM ~ 210 BPM)
        // 피크 간 시간차가 285ms(210 BPM) ~ 1500ms(40 BPM) 이내일 때만 유효 취급
        const timeDiff = peakTime - lastPeakTime;
        
        if (timeDiff > 285 && timeDiff < 1500) {
            peakTimestamps.current.push(peakTime);
            if (peakTimestamps.current.length > 5) {
                peakTimestamps.current.shift();
            }
            
            if (peakTimestamps.current.length >= 3) {
                const diffs = [];
                for(let i=1; i<peakTimestamps.current.length; i++) {
                    diffs.push(peakTimestamps.current[i] - peakTimestamps.current[i-1]);
                }
                // 평균 피크 간격으로 BPM 산출
                const avgDiff = diffs.reduce((a,b)=>a+b, 0) / diffs.length;
                let newBpm = 60000 / avgDiff;
                
                // 5. Physiological Rules (급격한 심박수 변화 차단)
                if (currentBpmRef.current !== null) {
                    const oldBpm = currentBpmRef.current;
                    // 인간의 심박은 1초만에 20% 이상 변하기 어려움 (노이즈 방어)
                    if (newBpm > oldBpm * 1.2) newBpm = oldBpm * 1.2;
                    if (newBpm < oldBpm * 0.8) newBpm = oldBpm * 0.8;
                    
                    // 6. Exponential Moving Average (EMA) 적용
                    // 새로운 측정값 비중 30%, 이전 상태 유지 70%로 극강의 부드러움 제공
                    newBpm = (newBpm * 0.3) + (oldBpm * 0.7);
                }
                
                currentBpmRef.current = newBpm;
                setBpm(Math.round(newBpm));
            }
        } else if (timeDiff > 1500) {
            // 맥박을 한참 놓쳤거나 신호가 초기화된 경우 기준점 리셋
            peakTimestamps.current = [peakTime];
        }
    }
  }, []);

  const processFrame = useCallback((timestamp: number) => {
    if (!videoElementRef.current || !canvasRef.current) return;
    
    // 재귀 호출
    rafId.current = requestAnimationFrame(processFrame);

    if (timestamp - lastDrawTime.current < FPS_INTERVAL) return;
    lastDrawTime.current = timestamp;

    const video = videoElementRef.current;
    const canvas = canvasRef.current;
    
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 중앙 50x50 추출 최적화
    const sampleSize = 50;
    const sx = Math.max(0, (video.videoWidth - sampleSize) / 2);
    const sy = Math.max(0, (video.videoHeight - sampleSize) / 2);
    
    ctx.drawImage(video, sx, sy, sampleSize, sampleSize, 0, 0, sampleSize, sampleSize);
    
    const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
    const data = imageData.data;
    
    let redSum = 0; let greenSum = 0; let blueSum = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      redSum += data[i]; greenSum += data[i+1]; blueSum += data[i+2];
    }

    const redAvg = redSum / count;
    const greenAvg = greenSum / count;
    const blueAvg = blueSum / count;
    
    // 손가락 접촉 판별 (혈류 조직 투과 시 붉은 빛 압도적)
    if (redAvg > 100 && redAvg > greenAvg * 1.3 && redAvg > blueAvg * 1.3) {
       setStatus('measuring');
       
       rawSignalBuffer.current.push(redAvg);
       timeBuffer.current.push(timestamp); // 타임스탬프 기록
       
       if (rawSignalBuffer.current.length > BUFFER_SIZE) {
           rawSignalBuffer.current.shift();
           timeBuffer.current.shift();
       }
       
       // 알고리즘 호출
       calculateBPM();
       
    } else {
       // 손가락이 떨어지거나 부적절할 경우 완벽히 상태 초기화
       setStatus('no_finger');
       setBpm(null);
       currentBpmRef.current = null;
       rawSignalBuffer.current = [];
       timeBuffer.current = [];
       peakTimestamps.current = [];
       setWaveform([]);
    }
  }, [calculateBPM]);

  const startMeasurement = async () => {
    try {
      setStatus('initializing');
      setErrorMsg(null);
      
      let stream: MediaStream;
      try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: 'environment' } },
            audio: false
          });
      } catch(e) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }, 
            audio: false
          });
      }
      
      streamRef.current = stream;
      setActiveStream(stream);
      
      if (!videoElementRef.current) {
        const vid = document.createElement('video');
        vid.setAttribute("playsinline", "true");
        vid.muted = true;
        videoElementRef.current = vid;
      }
      
      videoElementRef.current.srcObject = stream;
      await videoElementRef.current.play();

      const track = stream.getVideoTracks()[0];
      if (track) {
          try {
              const capabilities = track.getCapabilities?.() as any;
              if (capabilities && capabilities.torch) {
                 await track.applyConstraints({
                     advanced: [{ torch: true } as any]
                 });
              }
          } catch (e) {
              console.warn("이 브라우저는 플래시 제어를 지원하지 않음", e);
          }
      }
      
      if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
          canvasRef.current.width = 50;
          canvasRef.current.height = 50;
      }
      
      rafId.current = requestAnimationFrame(processFrame);
      
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMsg("카메라 권한이 거부되었거나 카메라를 찾을 수 없습니다.");
    }
  };

  useEffect(() => {
    return () => {
      stopMeasurement();
    };
  }, [stopMeasurement]);

  return { bpm, status, waveform, error: errorMsg, stream: activeStream, startMeasurement, stopMeasurement };
}
