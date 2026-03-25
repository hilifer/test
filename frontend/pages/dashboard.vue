<template>
  <div>
    <h1 class="text-3xl font-bold mb-6">Dashboard</h1>
    <UCard>
      <div class="flex flex-col gap-2">
        <p><strong>Welcome, {{ user?.full_name || user?.username }}!</strong></p>
        <p class="text-gray-500">Username: {{ user?.username }}</p>
        <p class="text-gray-500">Email: {{ user?.email }}</p>
        <p class="text-gray-500">
          Role:
          <UBadge :color="user?.is_superuser ? 'error' : 'info'">
            {{ user?.is_superuser ? 'Admin' : 'User' }}
          </UBadge>
        </p>
        <p class="text-gray-500">Member since: {{ formatDate(user?.created_at) }}</p>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { user } = useAuth()

function formatDate(dateStr?: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString()
}
</script>
