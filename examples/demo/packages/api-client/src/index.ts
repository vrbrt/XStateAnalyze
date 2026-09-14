import axios from 'axios';

export interface User {
  id: string;
  name: string;
  email: string;
}

export const api = axios.create({ baseURL: 'https://api.example.com/v1' });

const ORDERS_URL = 'https://orders.example.com';

export async function fetchUser(id: string): Promise<User> {
  const res = await api.get<User>(`/users/${id}`);
  return res.data;
}

export async function updateUser(user: User): Promise<User> {
  const res = await api.put<User>(`/users/${user.id}`, user);
  return res.data;
}

export async function listOrders(userId: string) {
  const res = await fetch(`${ORDERS_URL}/orders?user=${userId}`, { method: 'GET' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function openLiveFeed(userId: string) {
  const ws = new WebSocket(`wss://live.example.com/feed/${userId}`);
  ws.onmessage = (ev) => console.log(ev.data);
  return ws;
}

export class NotificationClient {
  constructor(private token: string) {}

  async send(userId: string, message: string) {
    return api.post('/notifications', { userId, message }, { headers: { Authorization: this.token } });
  }

  async sendMany(userIds: string[], message: string) {
    for (const id of userIds) await this.send(id, message);
  }
}
