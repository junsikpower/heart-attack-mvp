import { useState, useEffect, useRef, useCallback } from 'react';

export type MeasurementStatus = 'idle' | 'initializing' | 'measuring' | 'error' | 'no_finger';

interface CameraHeartRateResult {
  bpm: number | null;
  status: MeasurementStatus;
  waveform: number[];
  error: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  startMeasurement: () => Promise<void>;
  stopMeasurement: () => void;
}

const BUFFER_SIZE = 100;
const FPS_INTERVAL = 1000 / 30; // 30 FPS

export function useCameraHeartRate(): CameraHeartRateResult {
  const [bpm, setBpm] = useState<number | null>(null);
  const [status, setStatus] = useState<MeasurementStatus>('idle');
  const [waveform, setWaveform] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafId = useRef<number | null>(null);
  const lastDrawTime = useRef<number>(0);
  
  // 상태 변수들을 Ref로 관리하여 requestAnimationFrame 루프 내에서 접근
  const rawSignalBuffer = useRef<number[]>([]);
  const peakTimestamps = useRef<number[]>([]);

  const stopMeasurement = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setStatus('idle');
    setBpm(null);
    setWaveform([]);
    rawSignalBuffer.current = [];
    peakTimestamps.current = [];
  }, []);

  const windowAverage = (arr: number[], size: number) => {
    if (arr.length < size) return arr[arr.length - 1] || 0;
    let sum = 0;
    for (let i = arr.length - size; i < arr.length; i++) {
        sum += arr[i];
    }
    return sum / size;
  };

  const calculateBPM = useCallback((timestamp: number) => {
    const buf = rawSignalBuffer.current;
    if (buf.length < 5) return;
    
    // 최근 3포인트씩의 이동 평균을 구하여 기울기 변화를 계산
    const v0 = windowAverage(buf.slice(0, buf.length - 2), 3);
    const v1 = windowAverage(buf.slice(0, buf.length - 1), 3);
    const v2 = windowAverage(buf, 3);
    
    // 피크 검출: 값이 올라갔다가 떨어지는 지점 (혈류량 변화)
    if (v1 > v0 && v1 > v2) {
        // 노이즈(자잘한 변화) 무시하기 위한 최소 진폭 설정
        const recentMin = Math.min(...buf.slice(-30));
        const recentMax = Math.max(...buf.slice(-30));
        const amplitude = recentMax - recentMin;

        if (amplitude > 1.5 && (v1 - recentMin) > amplitude * 0.6) {
           // 중복 피크(너무 가까운 피크) 무시 (최소 300ms = 200BPM 제한)
           const lastPeakTime = peakTimestamps.current[peakTimestamps.current.length - 1] || 0;
           if (timestamp - lastPeakTime > 300) {
               peakTimestamps.current.push(timestamp);
               
               // 최근 10개의 피크만 저장
               if (peakTimestamps.current.length > 10) {
                   peakTimestamps.current.shift();
               }
               
               // 피크 간격을 통해 BPM 단기 계산
               if (peakTimestamps.current.length >= 3) {
                   const diffs = [];
                   for(let i=1; i<peakTimestamps.current.length; i++) {
                       diffs.push(peakTimestamps.current[i] - peakTimestamps.current[i-1]);
                   }
                   const avgDiff = diffs.reduce((a,b)=>a+b, 0) / diffs.length;
                   const calcBpm = 60000 / avgDiff;
                   
                   // 유효한 사람의 심박수 범위 내인 경우만
                   if (calcBpm > 40 && calcBpm < 220) {
                       setBpm(Math.round(calcBpm));
                   }
               }
           }
        }
    }
  }, []);

  const processFrame = useCallback((timestamp: number) => {
    if (!videoRef.current || !canvasRef.current) return;
    
    if (timestamp - lastDrawTime.current < FPS_INTERVAL) {
        rafId.current = requestAnimationFrame(processFrame);
        return;
    }
    lastDrawTime.current = timestamp;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    // 비디오가 재생 중일때만 처리
    if (video.videoWidth === 0 || video.videoHeight === 0) {
        rafId.current = requestAnimationFrame(processFrame);
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 비디오 중앙 50x50 영역만 캔버스에 복사 (성능 최적화)
    const sampleSize = 50;
    const sx = Math.max(0, (video.videoWidth - sampleSize) / 2);
    const sy = Math.max(0, (video.videoHeight - sampleSize) / 2);
    
    ctx.drawImage(video, sx, sy, sampleSize, sampleSize, 0, 0, sampleSize, sampleSize);
    
    const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
    const data = imageData.data;
    
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      redSum += data[i];
      greenSum += data[i+1];
      blueSum += data[i+2];
    }

    const redAvg = redSum / count;
    const greenAvg = greenSum / count;
    const blueAvg = blueSum / count;
    
    // 손가락이 카메라를 완전히 덮었는지 판별하는 간단한 휴리스틱 알고리즘
    // 피부 조직을 투과한 빛은 빨간색 채널이 압도적으로 높음
    if (redAvg > 120 && redAvg > greenAvg * 1.5 && redAvg > blueAvg * 1.5) {
       setStatus('measuring');
       
       rawSignalBuffer.current.push(redAvg);
       if (rawSignalBuffer.current.length > BUFFER_SIZE) {
           rawSignalBuffer.current.shift();
       }
       
       calculateBPM(timestamp);
       
       // UI 웨이브폼용으로 렌더링하도록 얕은 복사
       setWaveform([...rawSignalBuffer.current]);

    } else {
       // 손가락이 떼어졌거나 렌즈 중앙에 제대로 위치하지 않은 상태
       setStatus('no_finger');
       setBpm(null); // 신뢰할 수 없는 데이터 초기화
       rawSignalBuffer.current = [];
       peakTimestamps.current = [];
       setWaveform([]);
    }
    
    rafId.current = requestAnimationFrame(processFrame);
  }, [calculateBPM]);

  const startMeasurement = async () => {
    try {
      setStatus('initializing');
      setErrorMsg(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, // 후면 카메라 우선
        audio: false
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true"); // 모바일 브라우저 팝업 방지
        await videoRef.current.play();
      }

      // 플래시(Torch) 켜기 시도
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
              console.warn("이 브라우저/기기는 카메라 플래시 제어를 지원하지 않습니다.", e);
          }
      }
      
      // 처리용 히든 캔버스 준비
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

  return { bpm, status, waveform, error: errorMsg, videoRef, startMeasurement, stopMeasurement };
}
