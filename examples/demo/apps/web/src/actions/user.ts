'use server';

import { updateUser, type User } from '@demo/api-client';

export async function saveUserAction(user: User) {
  return updateUser(user);
}

export async function deleteUserAction(id: string) {
  await fetch(`https://api.example.com/v1/users/${id}`, { method: 'DELETE' });
}
