package com.acme.users;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEventsListener {
  private final UserService userService;

  public OrderEventsListener(UserService userService) { this.userService = userService; }

  @KafkaListener(topics = "${orders.topic}", groupId = "users")
  public void onOrderCreated(String payload) {
    userService.findById(Long.parseLong(payload));
  }
}
