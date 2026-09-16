import adapter from '@sveltejs/adapter-auto';

// files: { routes: 'src/decoy' } — a commented-out configuration the reader must ignore.
export default {
  kit: {
    adapter: adapter(),
    files: {
      assets: 'static',
      routes: 'src/pages'
    }
  }
};
