import { useState, useEffect, useRef, useCallback } from 'react';

export type MeasurementStatus = 'idle' | 'initializing' | 'measuring' | 'error' | 'no_finger';

interface CameraHeartRateResult {
  bpm: number | null;
  status: MeasurementStatus;
  waveform: number[];
  error: string | null;
  stream: MediaStream | null;
  needsManualFlash: boolean;
  startMeasurement: () => Promise<void>;
  stopMeasurement: () => void;
  confirmManualFlash: () => void;
}

const BUFFER_SIZE = 150; // 약 5초 분량 (30 FPS 기준)
const FPS_INTERVAL = 1000 / 30; // 30 FPS 타겟

export function useCameraHeartRate(): CameraHeartRateResult {
  const [bpm, setBpm] = useState<number | null>(null);
  const [status, setStatus] = useState<MeasurementStatus>('idle');
  const [waveform, setWaveform] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [needsManualFlash, setNeedsManualFlash] = useState<boolean>(false);
  
  // NATIVE_MIGRATION_NOTE: 네이티브 앱(React Native) 설정 시 아래 DOM 객체 기반 부분은 완전히 제거됩니다.
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafId = useRef<number | null>(null);
  const lastDrawTime = useRef<number>(0);
  
  const rawSignalBuffer = useRef<number[]>([]);
  const timeBuffer = useRef<number[]>([]);
  const peakTimestamps = useRef<number[]>([]);
  const currentBpmRef = useRef<number | null>(null);

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
    setNeedsManualFlash(false);
    rawSignalBuffer.current = [];
    timeBuffer.current = [];
    peakTimestamps.current = [];
    currentBpmRef.current = null;
  }, []);

  const confirmManualFlash = useCallback(() => {
    setNeedsManualFlash(false);
    setStatus('measuring'); 
    // 정지 상태였다면 다시 루프 시작
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(processFrame);
  }, []);

  const calculateBPM = useCallback(() => {
    const raw = rawSignalBuffer.current;
    if (raw.length < 30) return; 

    const recentRaw = raw.slice(-60);
    const minRaw = Math.min(...recentRaw);
    const maxRaw = Math.max(...recentRaw);
    const range = maxRaw - minRaw;

    if (range < 0.5) return; 

    const filtered: number[] = [];
    const timestamps = timeBuffer.current;

    for (let i = 0; i < raw.length; i++) {
        const normalized = (raw[i] - minRaw) / range;
        filtered.push(normalized);
    }
    
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

    setWaveform(smoothed.slice(-100));

    if (smoothed.length < 3) return;
    
    const v0 = smoothed[smoothed.length - 3];
    const v1 = smoothed[smoothed.length - 2];
    const v2 = smoothed[smoothed.length - 1];
    
    if (v1 > v0 && v1 > v2 && v1 > 0.4) { 
        const peakTime = timestamps[timestamps.length - 2];
        const lastPeakTime = peakTimestamps.current[peakTimestamps.current.length - 1] || 0;
        
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
                const avgDiff = diffs.reduce((a,b)=>a+b, 0) / diffs.length;
                let newBpm = 60000 / avgDiff;
                
                if (currentBpmRef.current !== null) {
                    const oldBpm = currentBpmRef.current;
                    if (newBpm > oldBpm * 1.2) newBpm = oldBpm * 1.2;
                    if (newBpm < oldBpm * 0.8) newBpm = oldBpm * 0.8;
                    newBpm = (newBpm * 0.3) + (oldBpm * 0.7);
                }
                
                currentBpmRef.current = newBpm;
                setBpm(Math.round(newBpm));
            }
        } else if (timeDiff > 1500) {
            peakTimestamps.current = [peakTime];
        }
    }
  }, []);

  const processFrame = useCallback((timestamp: number) => {
    // NATIVE_MIGRATION_NOTE: 네이티브 앱 전환 시, 이 함수 전체(Canvas 순회)를 날리고 Frame Processor를 사용합니다.
    if (!videoElementRef.current || !canvasRef.current) return;
    
    rafId.current = requestAnimationFrame(processFrame);

    // 수동 제어(손전등 대기) 중인 경우 연산 블록
    // 여기서 return만 해도 콜백은 계속 등록되므로 프레임은 대기함
    if (needsManualFlash) return;

    if (timestamp - lastDrawTime.current < FPS_INTERVAL) return;
    lastDrawTime.current = timestamp;

    const video = videoElementRef.current;
    const canvas = canvasRef.current;
    
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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
    
    if (redAvg > 100 && redAvg > greenAvg * 1.3 && redAvg > blueAvg * 1.3) {
       setStatus('measuring');
       
       rawSignalBuffer.current.push(redAvg);
       timeBuffer.current.push(timestamp);
       
       if (rawSignalBuffer.current.length > BUFFER_SIZE) {
           rawSignalBuffer.current.shift();
           timeBuffer.current.shift();
       }
       
       calculateBPM();
       
    } else {
       setStatus('no_finger');
       setBpm(null);
       currentBpmRef.current = null;
       rawSignalBuffer.current = [];
       timeBuffer.current = [];
       peakTimestamps.current = [];
       setWaveform([]);
    }
  }, [calculateBPM, needsManualFlash]);

  const startMeasurement = async () => {
    try {
      setStatus('initializing');
      setErrorMsg(null);
      setNeedsManualFlash(false);
      
      // NATIVE_MIGRATION_NOTE: 네이티브 앱에서는 enumerateDevices 대신 expo-camera 등의 device 속성(device='back') 하나로 끝납니다.
      // 1. 임시 스트림 통과 (iOS 라벨 읽기용)
      const dummyStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      let bestDeviceId: string | null = null;
      for (const device of videoDevices) {
          const label = device.label.toLowerCase();
          // 아이폰 다중 렌즈 자동전환 방지를 위한 메인 렌즈 색출
          if (label.includes('back') || label.includes('후면')) {
              if (!label.includes('ultra') && !label.includes('telephoto')) {
                  bestDeviceId = device.deviceId;
                  break;
              }
          }
      }

      dummyStream.getTracks().forEach(t => t.stop());

      // 2. 최적 렌즈로 진짜 스트림 연결
      let stream: MediaStream;
      const constraints: MediaStreamConstraints = {
          video: bestDeviceId 
              ? { deviceId: { exact: bestDeviceId } }
              : { facingMode: { ideal: 'environment' } },
          audio: false
      };
      
      try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
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

      // NATIVE_MIGRATION_NOTE: 네이티브 앱에서는 Torch 제어가 보장되므로, 수동 플래시 모달 시스템 전체 파기가 가능합니다.
      // 3. 플래시 비동기 켜기 및 권한 에러 분별
      let flashSuccess = false;
      const track = stream.getVideoTracks()[0];
      if (track) {
          try {
              const capabilities = track.getCapabilities?.() as any;
              if (capabilities && capabilities.torch) {
                 await track.applyConstraints({
                     advanced: [{ torch: true } as any]
                 });
                 flashSuccess = true;
              }
          } catch (e) {
              console.warn("브라우저 환경 플래시 제어 불가. 상태값 전환(에러 분리)");
          }
      }
      
      if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
          canvasRef.current.width = 50;
          canvasRef.current.height = 50;
      }
      
      if (!flashSuccess) {
          // 모달 유도 상태 방출
          setNeedsManualFlash(true);
      } else {
          setStatus('idle');
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

  return { 
      bpm, 
      status, 
      waveform, 
      error: errorMsg, 
      stream: activeStream, 
      needsManualFlash, 
      startMeasurement, 
      stopMeasurement,
      confirmManualFlash
  };
}
