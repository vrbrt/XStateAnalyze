package com.acme.users;

import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Primary
@Component
public class EmailNotificationGateway implements NotificationGateway {
  private final RestTemplate restTemplate = new RestTemplate();

  @Override
  public void notify(String email, String message) {
    restTemplate.postForObject("https://mailer.example.com/send", new MailRequest(email, message), Void.class);
  }
}
