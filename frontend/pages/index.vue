<template>
  <div class="flex flex-col items-center justify-center min-h-[60vh] gap-6">
    <h1 class="text-4xl font-bold">User Management System</h1>
    <p class="text-lg text-gray-500">Nuxt 4 + Python FastAPI Full Stack</p>
    <div class="flex gap-4">
      <UButton to="/login" size="lg">Login</UButton>
      <UButton to="/register" size="lg" variant="outline">Register</UButton>
    </div>
  </div>
</template>
