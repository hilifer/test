<template>
  <div>
    <h1 class="text-3xl font-bold mb-6">My Profile</h1>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <UCard>
        <template #header>
          <h3 class="text-lg font-semibold">Edit Profile</h3>
        </template>
        <form @submit.prevent="handleUpdateProfile" class="flex flex-col gap-4">
          <UFormField label="Email">
            <UInput v-model="profileForm.email" type="email" class="w-full" />
          </UFormField>
          <UFormField label="Full Name">
            <UInput v-model="profileForm.full_name" class="w-full" />
          </UFormField>
          <p v-if="profileMsg" :class="profileError ? 'text-red-500' : 'text-green-500'" class="text-sm">
            {{ profileMsg }}
          </p>
          <UButton type="submit" :loading="profileLoading">Save Changes</UButton>
        </form>
      </UCard>

      <UCard>
        <template #header>
          <h3 class="text-lg font-semibold">Change Password</h3>
        </template>
        <form @submit.prevent="handleChangePassword" class="flex flex-col gap-4">
          <UFormField label="Current Password">
            <UInput v-model="pwForm.old_password" type="password" class="w-full" />
          </UFormField>
          <UFormField label="New Password">
            <UInput v-model="pwForm.new_password" type="password" class="w-full" />
          </UFormField>
          <p v-if="pwMsg" :class="pwError ? 'text-red-500' : 'text-green-500'" class="text-sm">
            {{ pwMsg }}
          </p>
          <UButton type="submit" :loading="pwLoading">Change Password</UButton>
        </form>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { user, updateProfile, changePassword } = useAuth()

const profileForm = reactive({
  email: user.value?.email || '',
  full_name: user.value?.full_name || '',
})
const profileMsg = ref('')
const profileError = ref(false)
const profileLoading = ref(false)

watch(user, (u) => {
  if (u) {
    profileForm.email = u.email
    profileForm.full_name = u.full_name
  }
}, { immediate: true })

async function handleUpdateProfile() {
  profileLoading.value = true
  profileMsg.value = ''
  try {
    await updateProfile(profileForm)
    profileMsg.value = 'Profile updated!'
    profileError.value = false
  } catch (e: any) {
    profileMsg.value = e?.data?.detail || 'Update failed'
    profileError.value = true
  } finally {
    profileLoading.value = false
  }
}

const pwForm = reactive({ old_password: '', new_password: '' })
const pwMsg = ref('')
const pwError = ref(false)
const pwLoading = ref(false)

async function handleChangePassword() {
  pwLoading.value = true
  pwMsg.value = ''
  try {
    await changePassword(pwForm.old_password, pwForm.new_password)
    pwMsg.value = 'Password changed!'
    pwError.value = false
    pwForm.old_password = ''
    pwForm.new_password = ''
  } catch (e: any) {
    pwMsg.value = e?.data?.detail || 'Failed to change password'
    pwError.value = true
  } finally {
    pwLoading.value = false
  }
}
</script>
