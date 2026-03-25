<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <header class="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16 items-center">
          <NuxtLink to="/dashboard" class="text-xl font-bold text-primary">
            User Management
          </NuxtLink>
          <nav v-if="isLoggedIn" class="flex items-center gap-4">
            <NuxtLink to="/dashboard" class="text-sm hover:text-primary">Dashboard</NuxtLink>
            <NuxtLink to="/profile" class="text-sm hover:text-primary">Profile</NuxtLink>
            <NuxtLink v-if="isAdmin" to="/admin/users" class="text-sm hover:text-primary">
              User Admin
            </NuxtLink>
            <UButton size="sm" variant="ghost" @click="logout">Logout</UButton>
          </nav>
        </div>
      </div>
    </header>
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
const { isLoggedIn, isAdmin, logout } = useAuth()
</script>
