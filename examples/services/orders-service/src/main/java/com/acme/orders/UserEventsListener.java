package com.acme.orders;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class UserEventsListener {
  @KafkaListener(topics = "users.updated")
  public void onUserUpdated(String payload) {
    System.out.println(payload);
  }
}
