<template>
  <div class="flex justify-center mt-20">
    <UCard class="w-full max-w-md">
      <template #header>
        <h2 class="text-2xl font-bold text-center">Login</h2>
      </template>

      <form @submit.prevent="handleLogin" class="flex flex-col gap-4">
        <UFormField label="Username">
          <UInput v-model="form.username" placeholder="Enter username" required class="w-full" />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="form.password" type="password" placeholder="Enter password" required class="w-full" />
        </UFormField>
        <p v-if="error" class="text-red-500 text-sm">{{ error }}</p>
        <UButton type="submit" block :loading="loading">Login</UButton>
      </form>

      <template #footer>
        <p class="text-center text-sm text-gray-500">
          Don't have an account?
          <NuxtLink to="/register" class="text-primary hover:underline">Register</NuxtLink>
        </p>
      </template>
    </UCard>
  </div>
</template>

<script setup lang="ts">
const { login } = useAuth()

const form = reactive({ username: '', password: '' })
const error = ref('')
const loading = ref(false)

async function handleLogin() {
  loading.value = true
  error.value = ''
  try {
    await login(form)
    navigateTo('/dashboard')
  } catch (e: any) {
    error.value = e?.data?.detail || 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>
