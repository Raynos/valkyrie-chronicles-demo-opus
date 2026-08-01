export default {
  // Relative asset URLs, so `dist/` boots from a sub-path as well as from a domain
  // root. Without this vite emits `<script src="/assets/index-*.js">`, which 404s
  // on a GitHub Pages project site, an S3 prefix or any `/demo/` preview — and the
  // failure is silent: the page stays a dark rectangle with no error. Everything the
  // game loads is bundled or procedurally generated, so there is no other absolute
  // asset URL in the tree to chase.
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
};
