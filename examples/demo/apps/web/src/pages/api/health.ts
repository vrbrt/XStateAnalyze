import { getUsersFromDb } from '@/lib/data';
export default async function handler(req: any, res: any) {
  const users = await getUsersFromDb();
  res.status(200).json({ ok: true, users: users.length });
}
