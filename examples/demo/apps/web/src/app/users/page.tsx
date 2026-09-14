import { UserCard } from '@/components/UserCard';

export default async function UsersPage() {
  const res = await fetch('https://api.example.com/v1/users', { next: { revalidate: 60 } });
  const users: { id: string }[] = await res.json();
  return (
    <main>
      {users.map((u) => (
        <UserCard key={u.id} userId={u.id} />
      ))}
    </main>
  );
}
