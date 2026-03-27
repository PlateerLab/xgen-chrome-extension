import type { PageHandler } from '../types';
import { CanvasHandler } from './canvas-handler';
import { GenericHandler } from './generic-handler';

// CanvasHandler: ReactFlow canvasRef 접근을 위한 CustomEvent bridge 필수 → 유지
// GenericHandler: @page-agent/page-controller 기반으로 모든 페이지 커버 (workflows/data/admin 제거)
// Order matters: first match wins, GenericHandler is always last (fallback)
export function createHandlerRegistry(): PageHandler[] {
  return [
    new CanvasHandler(),
    new GenericHandler(), // fallback — PageController로 모든 페이지 처리
  ];
}
