// Server side implemented against the generated router (also absent): handlers are named after operationIds.
import { getUsersFromDb } from '@/lib/data';

export async function listUsers(req: any, res: any) {
  res.json(await getUsersFromDb());
}

export async function getUserById(req: any, res: any) {
  const users = await getUsersFromDb();
  res.json(users.find((u: any) => u.id === req.params.id));
}

// a helper with an operation-like name but no server signature: must NOT be tagged as a handler
export function createUser(name: string) {
  return { name };
}
