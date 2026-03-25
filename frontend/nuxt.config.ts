export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },

  fonts: {
    providers: {
      google: false,
      googleicons: false,
      bunny: false,
      fontshare: false,
      fontsource: false,
    },
  },

  runtimeConfig: {
    public: {
      apiBase: '',
    },
  },

  nitro: {
    devProxy: {
      '/api/': {
        target: 'http://127.0.0.1:8000/api/',
        changeOrigin: true,
      },
    },
  },

  compatibilityDate: '2025-01-01',
})
