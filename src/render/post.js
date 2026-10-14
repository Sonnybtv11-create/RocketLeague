// OWNER: VFX agent (post-processing).
// createPost(ctx) -> { render(), setSize(w, h, pixelRatio), setQuality(name), dispose() }
//
// Pipeline (medium/high/ultra):
//   RenderPass (into a HalfFloat, 4x MSAA target with a depth texture — linear HDR)
//   -> GTAOPass            (ultra only: ctx.quality.ssao)
//   -> UnrealBloomPass     (high threshold: only emissives / HDR effects bloom)
//   -> MotionBlurPass      (settings.graphics.motionBlur: camera-reprojection blur from depth)
//   -> OutputPass          (ACES tone mapping + sRGB, from renderer settings)
//   -> FXAA                (only when the preset has no MSAA)
// 'low' (or bloom off) bypasses the composer entirely: plain renderer.render().
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { QUALITY } from '../contracts.js';

// ---- camera motion blur ---------------------------------------------------------
// Reconstructs each pixel's world position from depth, reprojects it with last
// frame's view-projection and blurs along the screen-space delta. Pixels close
// to the camera (the player's car, which moves with the camera) are masked out.
const MB_SHADER = {
  uniforms: {
    tColor: { value: null }, tDepth: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() }, uStrength: { value: 0.5 }, uMaxLen: { value: 0.035 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform vec3 uCamPos;
    uniform float uStrength;
    uniform float uMaxLen;
    varying vec2 vUv;
    void main() {
      float depth = texture2D(tDepth, vUv).x;
      vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 wp = uInvViewProj * ndc;
      wp /= wp.w;
      vec4 prev = uPrevViewProj * wp;
      vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
      vec2 vel = (vUv - prevUv) * uStrength;
      float dist = length(wp.xyz - uCamPos);
      vel *= smoothstep(4.5, 11.0, dist);
      float L = length(vel);
      if (L > uMaxLen) vel *= uMaxLen / L;
      vec4 col = texture2D(tColor, vUv);
      if (L < 0.0008) { gl_FragColor = col; return; }
      vec4 acc = col;
      float w = 1.0;
      for (int i = 1; i < 8; i++) {
        float t = float(i) / 7.0 - 0.5;
        acc += texture2D(tColor, vUv + vel * t);
        w += 1.0;
      }
      gl_FragColor = acc / w;
    }`,
};

class MotionBlurPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(MB_SHADER.uniforms),
      vertexShader: MB_SHADER.vertexShader, fragmentShader: MB_SHADER.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.prevVP = new THREE.Matrix4();
    this.curVP = new THREE.Matrix4();
    this.hasPrev = false;
  }
  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.curVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this.hasPrev) { this.prevVP.copy(this.curVP); this.hasPrev = true; }
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.depthTexture || readBuffer.depthTexture;
    u.uInvViewProj.value.copy(this.curVP).invert();
    u.uPrevViewProj.value.copy(this.prevVP);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
    this.prevVP.copy(this.curVP);
  }
  reset() { this.hasPrev = false; }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

export function createPost(ctx) {
  const { renderer, scene, camera } = ctx;
  let width = innerWidth, height = innerHeight, pixelRatio = renderer.getPixelRatio();
  let composer = null, renderPass, bloom, gtao = null, mblur, output, fxaa = null;
  let enabled = false, qualityName = null, samples = -1;

  function makeTarget(w, h, s) {
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: s });
    rt.texture.name = 'post.rt';
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  }

  function disposeComposer() {
    if (!composer) return;
    for (const p of composer.passes) p.dispose && p.dispose();
    composer.renderTarget1.depthTexture && composer.renderTarget1.depthTexture.dispose();
    composer.renderTarget2.depthTexture && composer.renderTarget2.depthTexture.dispose();
    composer.dispose();
    composer = null; gtao = null; fxaa = null;
  }

  function build() {
    disposeComposer();
    const q = QUALITY[qualityName] || ctx.quality || QUALITY.high;
    enabled = !!q.bloom;
    if (!enabled) return;
    const w = Math.max(1, Math.floor(width * pixelRatio)), h = Math.max(1, Math.floor(height * pixelRatio));
    samples = q.antialias ? (pixelRatio >= 1.75 ? 2 : 4) : 0;
    composer = new EffectComposer(renderer, makeTarget(w, h, samples));
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    if (q.ssao) {
      gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: 12 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      composer.addPass(gtao);
    }
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.32, 0.95);
    composer.addPass(bloom);
    mblur = new MotionBlurPass(camera);
    mblur.enabled = !!(ctx.settings.graphics && ctx.settings.graphics.motionBlur);
    composer.addPass(mblur);
    output = new OutputPass();
    composer.addPass(output);
    if (!q.antialias) { fxaa = new FXAAPass(); composer.addPass(fxaa); }
  }

  const post = {
    render() {
      // with info.autoReset disabled (debug), count every pass of the frame together
      if (!renderer.info.autoReset) renderer.info.reset();
      if (qualityName !== ctx.qualityName) { qualityName = ctx.qualityName; build(); }
      if (!enabled || !composer) { renderer.render(scene, camera); return; }
      const mb = !!(ctx.settings.graphics && ctx.settings.graphics.motionBlur);
      if (mb !== mblur.enabled) { mblur.enabled = mb; mblur.reset(); }
      // the RenderPass draws into the current read buffer: its depth feeds the motion blur
      // (GTAO swaps buffers, so the blur pass can't rely on its own readBuffer's depth)
      mblur.depthTexture = composer.readBuffer.depthTexture;
      composer.render();
    },
    setSize(w, h, pr) {
      width = w; height = h;
      if (pr) pixelRatio = pr;
      if (!composer) return;
      const q = QUALITY[qualityName] || QUALITY.high;
      const wantSamples = q.antialias ? (pixelRatio >= 1.75 ? 2 : 4) : 0;
      if (wantSamples !== samples) { build(); return; }
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height); // resizes every pass (bloom mips, GTAO targets)
      mblur.reset();
    },
    setQuality(name) {
      if (name === qualityName) return;
      qualityName = name;
      build();
    },
    dispose() { disposeComposer(); },
  };
  return post;
}
