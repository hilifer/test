<template>
  <div class="flex justify-center mt-20">
    <UCard class="w-full max-w-md">
      <template #header>
        <h2 class="text-2xl font-bold text-center">Register</h2>
      </template>

      <form @submit.prevent="handleRegister" class="flex flex-col gap-4">
        <UFormField label="Username">
          <UInput v-model="form.username" placeholder="Choose a username" required class="w-full" />
        </UFormField>
        <UFormField label="Email">
          <UInput v-model="form.email" type="email" placeholder="Enter email" required class="w-full" />
        </UFormField>
        <UFormField label="Full Name">
          <UInput v-model="form.full_name" placeholder="Enter full name" class="w-full" />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="form.password" type="password" placeholder="Choose a password" required class="w-full" />
        </UFormField>
        <p v-if="error" class="text-red-500 text-sm">{{ error }}</p>
        <p v-if="success" class="text-green-500 text-sm">{{ success }}</p>
        <UButton type="submit" block :loading="loading">Register</UButton>
      </form>

      <template #footer>
        <p class="text-center text-sm text-gray-500">
          Already have an account?
          <NuxtLink to="/login" class="text-primary hover:underline">Login</NuxtLink>
        </p>
      </template>
    </UCard>
  </div>
</template>

<script setup lang="ts">
const { register } = useAuth()

const form = reactive({ username: '', email: '', password: '', full_name: '' })
const error = ref('')
const success = ref('')
const loading = ref(false)

async function handleRegister() {
  loading.value = true
  error.value = ''
  success.value = ''
  try {
    await register(form)
    success.value = 'Registration successful! Redirecting to login...'
    setTimeout(() => navigateTo('/login'), 1500)
  } catch (e: any) {
    error.value = e?.data?.detail || 'Registration failed'
  } finally {
    loading.value = false
  }
}
</script>
