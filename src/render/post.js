// OWNER: VFX agent (post-processing). STUB.
// createPost(ctx) -> { render(), setSize(w, h), setQuality(name), dispose() }
export function createPost(ctx) {
  return {
    render() { ctx.renderer.render(ctx.scene, ctx.camera); },
    setSize() {}, setQuality() {}, dispose() {},
  };
}
