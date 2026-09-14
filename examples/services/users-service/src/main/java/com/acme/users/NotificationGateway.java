package com.acme.users;

public interface NotificationGateway {
  void notify(String email, String message);
}
