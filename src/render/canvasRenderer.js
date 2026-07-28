// src/render/canvasRenderer.js
// docs/ARCHITECTURE.md refers to the post stack as `canvasRenderer.js`; the
// implementation lives in canvasRenderPipeline.js. This re-export exists so an
// import of either path resolves to the same class.

export { CanvasRenderPipeline, default } from './canvasRenderPipeline.js';
