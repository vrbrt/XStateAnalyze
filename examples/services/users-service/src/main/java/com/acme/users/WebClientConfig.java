package com.acme.users;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

@Configuration
public class WebClientConfig {
  @Value("${orders.base-url}")
  private String ordersBaseUrl;

  @Bean
  public WebClient ordersWebClient(WebClient.Builder builder) {
    return builder.baseUrl(ordersBaseUrl).build();
  }

  @Bean
  public RestTemplate restTemplate() {
    return new RestTemplate();
  }
}
