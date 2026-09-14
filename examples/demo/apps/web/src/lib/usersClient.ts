// Generated clients are NOT present in the repo (generation step not run): the analyzer
// resolves these calls through openapi.yaml by operationId instead.
import { Configuration, UsersApi } from '@/generated/users-api';   // openapi-generator (typescript-axios) style
import { listUsers } from '@/generated/orval/users';                // orval style: functions named after operationId
import { UsersService } from './api.gen';                          // hey-api style: static service class
import createClient from 'openapi-fetch';                           // openapi-fetch: paths are literal

const usersApi = new UsersApi(new Configuration({ basePath: 'https://api.example.com/v1' }));
const client = createClient<any>({ baseUrl: 'https://api.example.com/v1' });

export async function loadUserProfile(id: string) {
  const user = await usersApi.getUserById(id);
  const all = await listUsers();
  await UsersService.createUser({ requestBody: { name: 'x' } });
  await client.GET('/orders/{id}/items', { params: { path: { id } } });
  return { user, count: all.length };
}

export async function removeUser(id: string) {
  return usersApi.usersControllerDeleteUser(id);
}
