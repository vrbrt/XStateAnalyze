package com.acme.orders;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import java.util.List;

@Service
public class OrderService {
  private final OrderRepository orders;
  private final KafkaTemplate<String, String> kafka;
  private final RestTemplate restTemplate;
  private final String usersBaseUrl;
  @Value("${orders.topic}")
  private String ordersTopic;

  public OrderService(OrderRepository orders, KafkaTemplate<String, String> kafka, RestTemplate restTemplate, @Value("${users.base-url}") String usersBaseUrl) {
    this.orders = orders;
    this.kafka = kafka;
    this.restTemplate = restTemplate;
    this.usersBaseUrl = usersBaseUrl;
  }

  public List<Order> forUser(Long userId) {
    return orders.findByUserId(userId);
  }

  public Order get(String id) {
    return orders.findById(id).orElseThrow();
  }

  public Order place(Order order) {
    UserRef user = restTemplate.getForObject(usersBaseUrl + "/users/" + order.userId(), UserRef.class);
    Order saved = orders.save(order);
    kafka.send(ordersTopic, saved.id());
    return saved;
  }

  public Invoice invoice(Long userId) {
    return new Invoice(userId, forUser(userId).size());
  }
}
