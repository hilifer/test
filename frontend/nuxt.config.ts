export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },

  runtimeConfig: {
    public: {
      apiBase: 'http://localhost:8000',
    },
  },

  compatibilityDate: '2025-01-01',
})
