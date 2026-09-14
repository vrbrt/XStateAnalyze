package com.acme.users;

import org.springframework.stereotype.Component;

@Component
public class SmsNotificationGateway implements NotificationGateway {
  @Override
  public void notify(String email, String message) {
    System.out.println("sms " + message);
  }
}
