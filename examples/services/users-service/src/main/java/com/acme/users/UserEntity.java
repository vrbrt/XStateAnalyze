package com.acme.users;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class UserEntity {
  @Id private Long id;
  private String email;
  public Long getId() { return id; }
  public String getEmail() { return email; }
}
