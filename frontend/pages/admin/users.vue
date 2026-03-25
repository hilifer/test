<template>
  <div>
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-3xl font-bold">User Management</h1>
      <div class="flex gap-2">
        <UInput v-model="search" placeholder="Search users..." @keyup.enter="loadUsers" />
        <UButton @click="loadUsers">Search</UButton>
      </div>
    </div>

    <UCard>
      <UTable :rows="users" :columns="columns" :loading="loading">
        <template #cell-is_active="{ row }">
          <UBadge :color="row.original.is_active ? 'success' : 'error'">
            {{ row.original.is_active ? 'Active' : 'Disabled' }}
          </UBadge>
        </template>
        <template #cell-is_superuser="{ row }">
          <UBadge :color="row.original.is_superuser ? 'error' : 'neutral'">
            {{ row.original.is_superuser ? 'Admin' : 'User' }}
          </UBadge>
        </template>
        <template #cell-created_at="{ row }">
          {{ formatDate(row.original.created_at) }}
        </template>
        <template #cell-actions="{ row }">
          <div class="flex gap-2">
            <UButton size="xs" variant="outline" @click="openEdit(row.original)">Edit</UButton>
            <UButton
              size="xs"
              variant="outline"
              :color="row.original.is_active ? 'warning' : 'success'"
              @click="toggleActive(row.original)"
            >
              {{ row.original.is_active ? 'Disable' : 'Enable' }}
            </UButton>
            <UButton
              size="xs"
              variant="outline"
              color="error"
              @click="handleDelete(row.original)"
              :disabled="row.original.is_superuser"
            >
              Delete
            </UButton>
          </div>
        </template>
      </UTable>

      <div class="flex justify-between items-center mt-4">
        <p class="text-sm text-gray-500">Total: {{ totalCount }} users</p>
        <div class="flex gap-2">
          <UButton size="sm" variant="outline" :disabled="page === 0" @click="page--; loadUsers()">
            Previous
          </UButton>
          <UButton size="sm" variant="outline" :disabled="(page + 1) * pageSize >= totalCount" @click="page++; loadUsers()">
            Next
          </UButton>
        </div>
      </div>
    </UCard>

    <UModal v-model:open="editOpen">
      <template #content>
        <UCard>
          <template #header>
            <h3 class="text-lg font-semibold">Edit User: {{ editUser?.username }}</h3>
          </template>
          <form @submit.prevent="handleEdit" class="flex flex-col gap-4">
            <UFormField label="Email">
              <UInput v-model="editForm.email" type="email" class="w-full" />
            </UFormField>
            <UFormField label="Full Name">
              <UInput v-model="editForm.full_name" class="w-full" />
            </UFormField>
            <p v-if="editMsg" class="text-sm" :class="editError ? 'text-red-500' : 'text-green-500'">
              {{ editMsg }}
            </p>
            <div class="flex gap-2 justify-end">
              <UButton variant="outline" @click="editOpen = false">Cancel</UButton>
              <UButton type="submit" :loading="editLoading">Save</UButton>
            </div>
          </form>
        </UCard>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['admin'] })

const { apiFetch } = useAuth()

const users = ref<any[]>([])
const totalCount = ref(0)
const loading = ref(false)
const search = ref('')
const page = ref(0)
const pageSize = 20

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'username', header: 'Username' },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'full_name', header: 'Full Name' },
  { accessorKey: 'is_active', header: 'Status' },
  { accessorKey: 'is_superuser', header: 'Role' },
  { accessorKey: 'created_at', header: 'Created' },
  { accessorKey: 'actions', header: 'Actions' },
]

async function loadUsers() {
  loading.value = true
  try {
    const [list, count] = await Promise.all([
      apiFetch<any[]>('/api/users/', {
        params: { skip: page.value * pageSize, limit: pageSize, search: search.value },
      }),
      apiFetch<{ count: number }>('/api/users/count', {
        params: { search: search.value },
      }),
    ])
    users.value = list
    totalCount.value = count.count
  } finally {
    loading.value = false
  }
}

// Edit modal
const editOpen = ref(false)
const editUser = ref<any>(null)
const editForm = reactive({ email: '', full_name: '' })
const editMsg = ref('')
const editError = ref(false)
const editLoading = ref(false)

function openEdit(u: any) {
  editUser.value = u
  editForm.email = u.email
  editForm.full_name = u.full_name
  editMsg.value = ''
  editOpen.value = true
}

async function handleEdit() {
  editLoading.value = true
  editMsg.value = ''
  try {
    await apiFetch(`/api/users/${editUser.value.id}`, {
      method: 'PUT',
      body: editForm,
    })
    editMsg.value = 'Updated!'
    editError.value = false
    await loadUsers()
    setTimeout(() => { editOpen.value = false }, 800)
  } catch (e: any) {
    editMsg.value = e?.data?.detail || 'Update failed'
    editError.value = true
  } finally {
    editLoading.value = false
  }
}

async function toggleActive(u: any) {
  await apiFetch(`/api/users/${u.id}`, {
    method: 'PUT',
    body: { is_active: !u.is_active },
  })
  await loadUsers()
}

async function handleDelete(u: any) {
  if (!confirm(`Delete user "${u.username}"?`)) return
  await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' })
  await loadUsers()
}

function formatDate(dateStr?: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString()
}

onMounted(() => loadUsers())
</script>
