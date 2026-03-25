export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },

  runtimeConfig: {
    public: {
      apiBase: '',
    },
  },

  nitro: {
    devProxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },

  compatibilityDate: '2025-01-01',
})
