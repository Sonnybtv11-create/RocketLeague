// OWNER: VFX agent (post-processing).
// createPost(ctx) -> { render(), setSize(w, h, pixelRatio), setQuality(name), dispose() }
//
// Custom, minimal-bandwidth chain (medium / high / ultra):
//   1. scene  -> sceneRT   HalfFloat, MSAA = quality.msaa samples (the ONLY multisampled target).
//                          A depth texture is attached (and resolved) only while motion blur is on.
//   2. GTAO   (ultra)      half resolution, OUTPUT.Off — its denoised AO texture is read by step 5.
//   3. motion blur (opt.)  sceneRT colour+depth -> mbRT (single-sample).
//   4. bloom               dual-filter chain at quality.bloomScale x canvas: soft-threshold prefilter,
//                          13-tap downsamples, tent upsamples (additive) — single-sample HalfFloat.
//   5. output              scene * AO + bloom -> exposure -> ACES -> sRGB, straight to the canvas
//                          (or to an 8-bit target + FXAA when quality.msaa == 0).
// Nothing is ever composited back into the MSAA target (safe on tile GPUs that invalidate the
// multisampled colour after resolve). 'low' (quality.bloom false) bypasses everything: renderer.render().
// Shadow maps: autoUpdate is disabled and needsUpdate set once per frame, so extra scene passes
// (GTAO normals, reflection probes) never re-render the shadow map.
import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { QUALITY } from '../contracts.js';

const BLOOM_LEVELS = 5;
const BLOOM_THRESHOLD = 1.25;   // linear HDR; lit surfaces & clear-coat highlights stay below
const BLOOM_KNEE = 0.5;
const BLOOM_STRENGTH = 0.55;

const VS = /* glsl */`
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const PREFILTER_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(40.0)); }
void main() {
  // 4 bilinear taps cover the source footprint when downscaling 2-4x
  vec3 c = (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float w = max(soft, br - uThreshold) / max(br, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}`;

const UP_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 col = s(vec2(0.0)) * 4.0
    + (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0
    + s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0));
  gl_FragColor = vec4(col / 16.0, 1.0);
}`;

const MB_FS = /* glsl */`
precision highp float;
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
  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  wp /= wp.w;
  vec4 prev = uPrevViewProj * wp;
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
  vec2 vel = (vUv - prevUv) * uStrength;
  vel *= smoothstep(4.5, 11.0, length(wp.xyz - uCamPos)); // keep the followed car / ball sharp
  float L = length(vel);
  if (L > uMaxLen) vel *= uMaxLen / L;
  vec4 col = texture2D(tColor, vUv);
  if (L < 0.0008) { gl_FragColor = col; return; }
  vec4 acc = col;
  for (int i = 1; i < 8; i++) acc += texture2D(tColor, vUv + vel * (float(i) / 7.0 - 0.5));
  gl_FragColor = acc / 8.0;
}`;

const OUT_FS = /* glsl */`
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAO;
uniform float uBloom;
uniform float uAO;
uniform float uAspect;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tScene, vUv);
  #ifdef USE_AO
    c.rgb *= mix(1.0, texture2D(tAO, vUv).r, uAO);
  #endif
  c.rgb += texture2D(tBloom, vUv).rgb * uBloom;
  c.a = 1.0;
  #if defined(ACES_FILMIC_TONE_MAPPING)
    c.rgb = ACESFilmicToneMapping(c.rgb);
  #elif defined(AGX_TONE_MAPPING)
    c.rgb = AgXToneMapping(c.rgb);
  #elif defined(NEUTRAL_TONE_MAPPING)
    c.rgb = NeutralToneMapping(c.rgb);
  #elif defined(LINEAR_TONE_MAPPING)
    c.rgb = LinearToneMapping(c.rgb);
  #endif
  #ifdef SRGB_TRANSFER
    c = sRGBTransferOETF(c);
  #endif
  // grade (display space): slightly muted saturation, a gentle S-curve and a soft lens vignette,
  // so the frame reads like a camera image instead of flat flood-filled colour
  vec3 g = clamp(c.rgb, 0.0, 1.0);
  float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(lum), g, 0.9);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.22);
  vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
  g *= 1.0 - 0.3 * smoothstep(0.4, 1.15, length(v));
  gl_FragColor = vec4(g, 1.0);
}`;

function raw(fs, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, ...extra });
}

export function createPost(ctx) {
  const { renderer, scene, camera } = ctx;
  let width = innerWidth, height = innerHeight, pixelRatio = renderer.getPixelRatio();
  let qualityName = null, q = QUALITY.high;
  let enabled = false, built = false, mbOn = false;
  let sceneRT = null, mbRT = null, ldrRT = null, gtao = null;
  const bloomRT = [];

  const prefilterMat = raw(PREFILTER_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: BLOOM_THRESHOLD }, uKnee: { value: BLOOM_KNEE } });
  const downMat = raw(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upMat = raw(UP_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  const mbMat = raw(MB_FS, {
    tColor: { value: null }, tDepth: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() }, uStrength: { value: 0.5 }, uMaxLen: { value: 0.035 },
  });
  const outMat = raw(OUT_FS, {
    tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
    uBloom: { value: BLOOM_STRENGTH }, uAO: { value: 0.85 }, uAspect: { value: 16 / 9 }, toneMappingExposure: { value: 1 },
  });
  const fxaaMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), vertexShader: FXAAShader.vertexShader, fragmentShader: FXAAShader.fragmentShader,
    depthTest: false, depthWrite: false,
  });
  const quad = new FullScreenQuad(null);
  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4();
  let hasPrevVP = false;
  let outKey = '';

  function pass(mat, target, clear = true) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    const ac = renderer.autoClear;
    renderer.autoClear = clear;
    quad.render(renderer);
    renderer.autoClear = ac;
  }

  const px = () => [Math.max(1, Math.floor(width * pixelRatio)), Math.max(1, Math.floor(height * pixelRatio))];

  function freeTargets() {
    if (sceneRT) { if (sceneRT.depthTexture) sceneRT.depthTexture.dispose(); sceneRT.dispose(); sceneRT = null; }
    if (mbRT) { mbRT.dispose(); mbRT = null; }
    if (ldrRT) { ldrRT.dispose(); ldrRT = null; }
    for (const rt of bloomRT) rt.dispose();
    bloomRT.length = 0;
    if (gtao) { gtao.dispose(); gtao = null; }
  }

  function build() {
    freeTargets();
    q = QUALITY[qualityName] || ctx.quality || QUALITY.high;
    enabled = !!q.bloom;
    built = true;
    hasPrevVP = false;
    outKey = '';
    if (!enabled) return;
    const [w, h] = px();
    mbOn = !!(ctx.settings.graphics && ctx.settings.graphics.motionBlur);
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: q.msaa || 0, depthBuffer: true });
    sceneRT.texture.name = 'post.scene';
    if (mbOn) {
      sceneRT.depthTexture = new THREE.DepthTexture(w, h);
      sceneRT.depthTexture.type = THREE.UnsignedIntType;
      sceneRT.resolveDepthBuffer = true;
      mbRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    } else {
      sceneRT.resolveDepthBuffer = false; // nobody samples depth: skip the depth resolve blit
    }
    const bs = q.bloomScale || 0.5;
    let bw = Math.max(1, Math.floor(w * bs)), bh = Math.max(1, Math.floor(h * bs));
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const rt = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.name = 'post.bloom' + i;
      bloomRT.push(rt);
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    if (q.ssao) {
      gtao = new GTAOPass(scene, camera, Math.max(1, w >> 1), Math.max(1, h >> 1));
      gtao.output = GTAOPass.OUTPUT.Off;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: 12 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    }
    if (!q.msaa) {
      ldrRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
      fxaaMat.uniforms.resolution.value.set(1 / w, 1 / h);
    }
  }

  function updateOutputDefines() {
    const key = `${renderer.toneMapping}|${renderer.outputColorSpace}|${!!gtao}`;
    if (key === outKey) return;
    outKey = key;
    const d = {};
    if (THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
    const tm = renderer.toneMapping;
    if (tm === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = '';
    else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
    else if (tm === THREE.NeutralToneMapping) d.NEUTRAL_TONE_MAPPING = '';
    else if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = '';
    if (gtao) d.USE_AO = '';
    outMat.defines = d;
    outMat.needsUpdate = true;
  }

  function renderBloom(src) {
    const s0 = bloomRT[0];
    prefilterMat.uniforms.tSrc.value = src;
    prefilterMat.uniforms.uTexel.value.set(0.5 / s0.width, 0.5 / s0.height);
    pass(prefilterMat, s0);
    for (let i = 1; i < bloomRT.length; i++) {
      downMat.uniforms.tSrc.value = bloomRT[i - 1].texture;
      downMat.uniforms.uTexel.value.set(1 / bloomRT[i - 1].width, 1 / bloomRT[i - 1].height);
      pass(downMat, bloomRT[i]);
    }
    for (let i = bloomRT.length - 1; i > 0; i--) {
      upMat.uniforms.tSrc.value = bloomRT[i].texture;
      upMat.uniforms.uTexel.value.set(1 / bloomRT[i].width, 1 / bloomRT[i].height);
      pass(upMat, bloomRT[i - 1], false);
    }
    return s0.texture;
  }

  const post = {
    render() {
      // debug: with info.autoReset disabled, count every pass of the frame together
      if (!renderer.info.autoReset) renderer.info.reset();
      // the shadow map renders at most once per frame, whatever extra scene passes run
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;

      if (!built || qualityName !== ctx.qualityName) { qualityName = ctx.qualityName; build(); }
      if (!enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      const wantMb = !!(ctx.settings.graphics && ctx.settings.graphics.motionBlur);
      if (wantMb !== mbOn) build();

      // 1. scene (linear HDR, MSAA)
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      let src = sceneRT.texture;

      // 2. GTAO (own half-res normal/depth pass; the shadow map is not re-rendered)
      if (gtao) gtao.render(renderer, null, sceneRT);

      // 3. motion blur
      if (mbOn && mbRT) {
        camera.updateMatrixWorld();
        curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        if (!hasPrevVP) { prevVP.copy(curVP); hasPrevVP = true; }
        const u = mbMat.uniforms;
        u.tColor.value = sceneRT.texture;
        u.tDepth.value = sceneRT.depthTexture;
        u.uInvViewProj.value.copy(curVP).invert();
        u.uPrevViewProj.value.copy(prevVP);
        u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
        pass(mbMat, mbRT);
        prevVP.copy(curVP);
        src = mbRT.texture;
      }

      // 4. bloom (single-sample chain)
      const bloomTex = renderBloom(sceneRT.texture);

      // 5. output: scene*AO + bloom -> ACES -> sRGB
      updateOutputDefines();
      outMat.uniforms.tScene.value = src;
      outMat.uniforms.tBloom.value = bloomTex;
      outMat.uniforms.tAO.value = gtao ? gtao.pdRenderTarget.texture : null;
      outMat.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
      outMat.uniforms.uAspect.value = width / Math.max(1, height);
      if (ldrRT) {
        pass(outMat, ldrRT);
        fxaaMat.uniforms.tDiffuse.value = ldrRT.texture;
        pass(fxaaMat, null);
      } else {
        pass(outMat, null);
      }
      renderer.setRenderTarget(null);
    },
    setSize(w, h, pr) {
      width = w; height = h;
      if (pr) pixelRatio = pr;
      if (built && enabled) build();
    },
    setQuality(name) {
      if (name === qualityName && built) return;
      qualityName = name;
      build();
    },
    dispose() {
      freeTargets();
      for (const m of [prefilterMat, downMat, upMat, mbMat, outMat, fxaaMat]) m.dispose();
      quad.dispose();
      renderer.shadowMap.autoUpdate = true;
    },
  };
  return post;
}
