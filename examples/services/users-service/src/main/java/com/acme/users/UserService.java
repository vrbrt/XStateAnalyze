package com.acme.users;

import java.util.List;
import java.util.Optional;

public interface UserService {
  List<UserDto> findAll();
  Optional<UserDto> findById(Long id);
  UserDto create(UserDto dto);
  void delete(Long id);
}
